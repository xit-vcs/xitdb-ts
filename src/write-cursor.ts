import { Tag } from './tag.js';
import { Slot } from './slot.js';
import { SlotPointer } from './slot-pointer.js';
import {
  Database,
  Header,
  Transaction,
  ArrayListInit,
  WriteMode,
  WriteData,
  type PathPart,
} from './database.js';
import {
  ReadCursor,
  KeyValuePairCursor,
  CursorIterator,
} from './read-cursor.js';
import {
  CursorNotWriteableException,
  ExpectedTxStartException,
  EndOfStreamException,
  UnexpectedWriterPositionException,
} from './exceptions.js';
import type { WriteableData } from './writeable-data.js';

export class WriteKeyValuePairCursor extends KeyValuePairCursor {
  override valueCursor: WriteCursor;
  override keyCursor: WriteCursor;

  constructor(valueCursor: WriteCursor, keyCursor: WriteCursor, hash: Uint8Array) {
    super(valueCursor, keyCursor, hash);
    this.valueCursor = valueCursor;
    this.keyCursor = keyCursor;
  }
}

export class WriteCursor extends ReadCursor {
  private readonly transaction: Transaction | null;

  constructor(slotPtr: SlotPointer, db: Database, transaction: Transaction | null = db.transaction) {
    super(slotPtr, db);
    this.transaction = slotPtr.position === null ? null : transaction;
  }

  // require the active transaction and a writable slot
  checkWritable(): void {
    const active = this.db.transaction;
    if (this.transaction !== null && this.transaction !== active) {
      throw new Error('Writer belongs to an expired transaction');
    }
    if (this.slotPtr.position !== null && this.db.header.tag === Tag.ARRAY_LIST && this.transaction === null) {
      throw new Error('Writer was created outside a transaction');
    }
    this.db.checkFrozenSlot(this.slotPtr);
  }

  slot(): Slot {
    // rollback may reclaim the storage this slot points to
    if (this.transaction !== null && this.transaction.aborted) {
      throw new Error('Writer belongs to an aborted transaction');
    }
    return super.slot();
  }

  // reload after freezing because copy-on-write may change where the slot points
  private reloadSlot(): void {
    if (this.transaction !== null && this.transaction.frozenAt !== null && this.slotPtr.position !== null) {
      this.db.core.seek(this.slotPtr.position);
      const bytes = new Uint8Array(Slot.LENGTH);
      this.db.core.reader().readFully(bytes);
      this.slotPtr = this.slotPtr.withSlot(Slot.fromBytes(bytes));
    }
  }

  writePath(path: PathPart[]): WriteCursor {
    this.checkWritable();
    // nested top-level writes could commit before the outer transaction ends
    if (this.db.transaction !== null && this.slotPtr.position === null && path.length > 0) {
      throw new Error('Nested top-level writes are not allowed');
    }
    // another instance may have initialized the top-level data since we read
    // the header. initializing it again would discard its data. `rootCursor`
    // checks as well, but this cursor may be older than that.
    if (this.slotPtr.position === null && this.slotPtr.slot.value === BigInt(Header.LENGTH)) {
      this.db.refreshHeader();
    }
    const startsTransaction = this.db.transaction === null && this.slotPtr.position === null
      && (this.db.header.tag === Tag.ARRAY_LIST || (path.length > 0 && path[0] instanceof ArrayListInit));
    if (startsTransaction) this.db.transaction = new Transaction();
    try {
      let slotPtr: SlotPointer;
      try {
        this.reloadSlot();
        slotPtr = this.db.readSlotPointer(WriteMode.READ_WRITE, path, 0, this.slotPtr);
      } catch (e) {
        if (startsTransaction && this.db.transaction !== null) this.db.transaction.aborted = true;
        // only truncate when the error escapes the outer write.
        // a nested callback's caller may still commit its work.
        if (this.db.txStart === null) {
          try {
            this.db.truncate();
          } catch (_) {}
        }
        throw e;
      }
      if (this.db.txStart === null) {
        this.db.core.sync();
      }
      this.reloadSlot();
      const cursor = new WriteCursor(slotPtr, this.db);
      cursor.reloadSlot();
      return cursor;
    } finally {
      if (startsTransaction) this.db.transaction = null;
    }
  }

  write(data: WriteableData | null): void {
    const cursor = this.writePath([new WriteData(data)]);
    this.slotPtr = cursor.slotPtr;
  }

  writeIfEmpty(data: WriteableData): void {
    this.checkWritable();
    if (this.slotPtr.slot.empty()) {
      this.write(data);
    }
  }

  override readKeyValuePair(): WriteKeyValuePairCursor {
    const kvPairCursor = super.readKeyValuePair();
    return new WriteKeyValuePairCursor(
      new WriteCursor(kvPairCursor.valueCursor.slotPtr, this.db, this.transaction),
      new WriteCursor(kvPairCursor.keyCursor.slotPtr, this.db, this.transaction),
      kvPairCursor.hash
    );
  }

  writer(): Writer {
    this.checkWritable();
    if (this.db.header.tag === Tag.ARRAY_LIST && this.db.txStart === null) throw new ExpectedTxStartException();
    const writer = this.db.core.writer();
    const ptrPos = this.db.core.length();
    this.db.core.seek(ptrPos);
    writer.writeLong(0);
    const startPosition = this.db.core.length();
    return new Writer(this, 0, new Slot(ptrPos, Tag.BYTES), startPosition, 0);
  }

  override iterator(): WriteCursorIterator {
    const iterator = new WriteCursorIterator(this);
    iterator.init();
    return iterator;
  }
}

export class Writer {
  parent: WriteCursor;
  size: number;
  slot: Slot;
  startPosition: number;
  relativePosition: number;
  formatTag: Uint8Array | null = null;

  constructor(
    parent: WriteCursor,
    size: number,
    slot: Slot,
    startPosition: number,
    relativePosition: number
  ) {
    this.parent = parent;
    this.size = size;
    this.slot = slot;
    this.startPosition = startPosition;
    this.relativePosition = relativePosition;
  }

  write(buffer: Uint8Array): void {
    this.checkWritable();
    if (this.size < this.relativePosition) throw new EndOfStreamException();
    const newPosition = this.relativePosition + buffer.length;

    // another allocation may now follow this byte array.
    // extending it would overwrite that allocation.
    if (newPosition > this.size) {
      const end = this.parent.db.core.length();
      if (end !== this.startPosition + this.size) throw new UnexpectedWriterPositionException();
    }

    this.parent.db.core.seek(this.startPosition + this.relativePosition);
    const writer = this.parent.db.core.writer();
    writer.write(buffer);
    this.relativePosition = newPosition;
    if (this.relativePosition > this.size) {
      this.size = this.relativePosition;
    }
  }

  finish(): void {
    this.checkWritable();
    const writer = this.parent.db.core.writer();

    if (this.formatTag !== null) {
      this.slot = this.slot.withFull(true);
      const formatTagPos = this.parent.db.core.length();
      this.parent.db.core.seek(formatTagPos);
      if (this.startPosition + this.size !== formatTagPos) throw new UnexpectedWriterPositionException();
      writer.write(this.formatTag);
    }

    this.parent.db.core.seek(Number(this.slot.value));
    writer.writeLong(this.size);

    if (this.parent.slotPtr.position === null) throw new CursorNotWriteableException();
    const position = this.parent.slotPtr.position;
    this.parent.db.core.seek(position);
    writer.write(this.slot.toBytes());

    this.parent.slotPtr = this.parent.slotPtr.withSlot(this.slot);
    if (this.parent.db.txStart === null) this.parent.db.core.sync();
  }

  // validate the parent cursor and reject writes to frozen bytes
  private checkWritable(): void {
    this.parent.checkWritable();
    if (this.parent.db.header.tag === Tag.ARRAY_LIST && this.parent.db.txStart === null) throw new ExpectedTxStartException();
    const active = this.parent.db.transaction;
    if (active !== null && active.frozenAt !== null && this.slot.value < active.frozenAt) {
      throw new Error('Byte writer points into frozen data');
    }
  }

  seek(position: number): void {
    if (position <= this.size) {
      this.relativePosition = position;
    }
  }
}

// iterators don't copy shared nodes, so their cursors must
// be read-only. this also prevents changes to sorted keys.
export class WriteCursorIterator extends CursorIterator {
  constructor(cursor: WriteCursor) {
    super(cursor);
  }

  // wrap an already-seeked read iterator for the write-side
  // iteratorFrom/iteratorFromIndex methods.
  static from(inner: CursorIterator): WriteCursorIterator {
    const it = new WriteCursorIterator(inner.cursor as WriteCursor);
    it.size = inner.size;
    it.index = inner.index;
    it.stack = inner.stack;
    return it;
  }
}

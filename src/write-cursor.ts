import { Tag } from './tag.js';
import { Slot } from './slot.js';
import { SlotPointer } from './slot-pointer.js';
import {
  Database,
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
  constructor(slotPtr: SlotPointer, db: Database) {
    super(slotPtr, db);
  }

  writePath(path: PathPart[]): WriteCursor {
    const slotPtr = this.db.readSlotPointer(WriteMode.READ_WRITE, path, 0, this.slotPtr);
    if (this.db.txStart === null) {
      this.db.core.sync();
    }
    return new WriteCursor(slotPtr, this.db);
  }

  write(data: WriteableData | null): void {
    const cursor = this.writePath([new WriteData(data)]);
    this.slotPtr = cursor.slotPtr;
  }

  writeIfEmpty(data: WriteableData): void {
    if (this.slotPtr.slot.empty()) {
      this.write(data);
    }
  }

  override readKeyValuePair(): WriteKeyValuePairCursor {
    const kvPairCursor = super.readKeyValuePair();
    return new WriteKeyValuePairCursor(
      new WriteCursor(kvPairCursor.valueCursor.slotPtr, this.db),
      new WriteCursor(kvPairCursor.keyCursor.slotPtr, this.db),
      kvPairCursor.hash
    );
  }

  writer(): Writer {
    const writer = this.db.core.writer();
    const ptrPos = this.db.core.length();
    this.db.core.seek(ptrPos);
    writer.writeLong(0);
    const startPosition = this.db.core.length();
    return new Writer(this, 0, new Slot(ptrPos, Tag.BYTES), startPosition, 0);
  }

  override *[Symbol.iterator](): Iterator<WriteCursor> {
    const iterator = this.iterator();
    while (iterator.hasNext()) {
      const next = iterator.next();
      if (next !== null) {
        yield next;
      }
    }
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
    if (this.size < this.relativePosition) throw new EndOfStreamException();
    this.parent.db.core.seek(this.startPosition + this.relativePosition);
    const writer = this.parent.db.core.writer();
    writer.write(buffer);
    this.relativePosition += buffer.length;
    if (this.relativePosition > this.size) {
      this.size = this.relativePosition;
    }
  }

  finish(): void {
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
  }

  seek(position: number): void {
    if (position <= this.size) {
      this.relativePosition = position;
    }
  }
}

export class WriteCursorIterator extends CursorIterator {
  constructor(cursor: WriteCursor) {
    super(cursor);
  }

  // wrap an already-seeked read iterator so it yields write cursors. backs the
  // write-side iteratorFrom/iteratorFromIndex methods.
  static from(inner: CursorIterator): WriteCursorIterator {
    const it = new WriteCursorIterator(inner.cursor as WriteCursor);
    it.size = inner.size;
    it.index = inner.index;
    it.stack = inner.stack;
    return it;
  }

  override next(): WriteCursor | null {
    const readCursor = super.next();
    if (readCursor !== null) {
      return new WriteCursor(readCursor.slotPtr, readCursor.db);
    } else {
      return null;
    }
  }
}

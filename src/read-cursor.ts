import { Tag } from './tag.js';
import { Slot } from './slot.js';
import { SlotPointer } from './slot-pointer.js';
import type { Slotted } from './slotted.js';
import {
  Database,
  WriteMode,
  ArrayListHeader,
  BTreeHeader,
  KeyValuePair,
  type PathPart,
  ArrayListGet,
  INDEX_BLOCK_SIZE,
  BTREE_NODE_HEADER_SIZE,
  BTreeNodeKind,
  SLOT_COUNT,
  BIT_COUNT,
} from './database.js';
import {
  UnexpectedTagException,
  StreamTooLongException,
  EndOfStreamException,
  InvalidOffsetException,
  KeyNotFoundException,
  ExpectedUnsignedLongException,
} from './exceptions.js';
import { Bytes } from './writeable-data.js';

export class KeyValuePairCursor {
  constructor(
    public valueCursor: ReadCursor,
    public keyCursor: ReadCursor,
    public hash: Uint8Array
  ) {}
}

export class ReadCursor implements Slotted {
  public slotPtr: SlotPointer;
  public db: Database;

  constructor(slotPtr: SlotPointer, db: Database) {
    this.slotPtr = slotPtr;
    this.db = db;
  }

  slot(): Slot {
    return this.slotPtr.slot;
  }

  readPath(path: PathPart[]): ReadCursor | null {
    try {
      const slotPtr = this.db.readSlotPointer(WriteMode.READ_ONLY, path, 0, this.slotPtr);
      return new ReadCursor(slotPtr, this.db);
    } catch (e) {
      if (e instanceof KeyNotFoundException) {
        return null;
      }
      throw e;
    }
  }

  readPathSlot(path: PathPart[]): Slot | null {
    try {
      const slotPtr = this.db.readSlotPointer(WriteMode.READ_ONLY, path, 0, this.slotPtr);
      if (!slotPtr.slot.empty()) {
        return slotPtr.slot;
      } else {
        return null;
      }
    } catch (e) {
      if (e instanceof KeyNotFoundException) {
        return null;
      }
      throw e;
    }
  }

  readUint(): number {
    if (this.slotPtr.slot.tag !== Tag.UINT) {
      throw new UnexpectedTagException();
    }
    if (this.slotPtr.slot.value < 0n) throw new ExpectedUnsignedLongException();
    return Number(this.slotPtr.slot.value);
  }

  readInt(): number {
    if (this.slotPtr.slot.tag !== Tag.INT) {
      throw new UnexpectedTagException();
    }
    return Number(this.slotPtr.slot.value);
  }

  readFloat(): number {
    if (this.slotPtr.slot.tag !== Tag.FLOAT) {
      throw new UnexpectedTagException();
    }
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    // Write value as 8 bytes big-endian (using BigInt operations)
    view.setBigInt64(0, this.slotPtr.slot.value, false);
    return view.getFloat64(0, false);
  }

  readBytes(maxSizeMaybe: number | null = null): Uint8Array {
    const bytesObj = this.readBytesObject(maxSizeMaybe);
    return bytesObj.value;
  }

  readBytesObject(maxSizeMaybe: number | null = null): Bytes {
    const reader = this.db.core.reader();

    switch (this.slotPtr.slot.tag) {
      case Tag.NONE:
        return new Bytes(new Uint8Array(0));
      case Tag.BYTES: {
        this.db.core.seek(Number(this.slotPtr.slot.value));
        const valueSize = reader.readLong();

        if (maxSizeMaybe !== null && valueSize > maxSizeMaybe) {
          throw new StreamTooLongException();
        }

        const startPosition = this.db.core.position();

        const value = new Uint8Array(valueSize);
        reader.readFully(value);

        let formatTag: Uint8Array | null = null;
        if (this.slotPtr.slot.full) {
          this.db.core.seek(startPosition + valueSize);
          formatTag = new Uint8Array(2);
          reader.readFully(formatTag);
        }

        return new Bytes(value, formatTag);
      }
      case Tag.SHORT_BYTES: {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        // Write value as 8 bytes big-endian (using BigInt operations)
        view.setBigInt64(0, this.slotPtr.slot.value, false);
        const bytes = new Uint8Array(buffer);

        const totalSize = this.slotPtr.slot.full ? bytes.length - 2 : bytes.length;

        let valueSize = 0;
        for (const b of bytes) {
          if (b === 0 || valueSize === totalSize) break;
          valueSize += 1;
        }

        if (maxSizeMaybe !== null && valueSize > maxSizeMaybe) {
          throw new StreamTooLongException();
        }

        let formatTag: Uint8Array | null = null;
        if (this.slotPtr.slot.full) {
          formatTag = bytes.slice(totalSize, bytes.length);
        }

        return new Bytes(bytes.slice(0, valueSize), formatTag);
      }
      default:
        throw new UnexpectedTagException();
    }
  }

  readKeyValuePair(): KeyValuePairCursor {
    const reader = this.db.core.reader();

    if (this.slotPtr.slot.tag !== Tag.KV_PAIR) {
      throw new UnexpectedTagException();
    }

    this.db.core.seek(Number(this.slotPtr.slot.value));
    const kvPairBytes = new Uint8Array(KeyValuePair.length(this.db.header.hashSize));
    reader.readFully(kvPairBytes);
    const kvPair = KeyValuePair.fromBytes(kvPairBytes, this.db.header.hashSize);

    const hashPos = Number(this.slotPtr.slot.value);
    const keySlotPos = hashPos + this.db.header.hashSize;
    const valueSlotPos = keySlotPos + Slot.LENGTH;

    return new KeyValuePairCursor(
      new ReadCursor(new SlotPointer(valueSlotPos, kvPair.valueSlot), this.db),
      new ReadCursor(new SlotPointer(keySlotPos, kvPair.keySlot), this.db),
      kvPair.hash
    );
  }

  reader(): Reader {
    const reader = this.db.core.reader();

    switch (this.slotPtr.slot.tag) {
      case Tag.BYTES: {
        this.db.core.seek(Number(this.slotPtr.slot.value));
        const size = reader.readLong();
        const startPosition = this.db.core.position();
        return new Reader(this, size, startPosition, 0);
      }
      case Tag.SHORT_BYTES: {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        // Write value as 8 bytes big-endian (using BigInt operations)
        view.setBigInt64(0, this.slotPtr.slot.value, false);
        const bytes = new Uint8Array(buffer);

        const totalSize = this.slotPtr.slot.full ? bytes.length - 2 : bytes.length;

        let valueSize = 0;
        for (const b of bytes) {
          if (b === 0 || valueSize === totalSize) break;
          valueSize += 1;
        }

        const startPosition = this.slotPtr.position! + 1;
        return new Reader(this, valueSize, startPosition, 0);
      }
      default:
        throw new UnexpectedTagException();
    }
  }

  count(): number {
    const reader = this.db.core.reader();
    switch (this.slotPtr.slot.tag) {
      case Tag.NONE:
        return 0;
      case Tag.ARRAY_LIST: {
        this.db.core.seek(Number(this.slotPtr.slot.value));
        const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
        reader.readFully(headerBytes);
        const header = ArrayListHeader.fromBytes(headerBytes);
        return header.size;
      }
      case Tag.LINKED_ARRAY_LIST:
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET: {
        this.db.core.seek(Number(this.slotPtr.slot.value));
        const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
        reader.readFully(headerBytes);
        const header = BTreeHeader.fromBytes(headerBytes);
        return header.size;
      }
      case Tag.BYTES: {
        this.db.core.seek(Number(this.slotPtr.slot.value));
        return reader.readLong();
      }
      case Tag.SHORT_BYTES: {
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        // Write value as 8 bytes big-endian (using BigInt operations)
        view.setBigInt64(0, this.slotPtr.slot.value, false);
        const bytes = new Uint8Array(buffer);

        const totalSize = this.slotPtr.slot.full ? bytes.length - 2 : bytes.length;

        let size = 0;
        for (const b of bytes) {
          if (b === 0 || size === totalSize) break;
          size += 1;
        }
        return size;
      }
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET: {
        this.db.core.seek(Number(this.slotPtr.slot.value));
        return reader.readLong();
      }
      default:
        throw new UnexpectedTagException();
    }
  }

  *[Symbol.iterator](): Iterator<ReadCursor> {
    const iterator = this.iterator();
    while (iterator.hasNext()) {
      const next = iterator.next();
      if (next !== null) {
        yield next;
      }
    }
  }

  iterator(): CursorIterator {
    const iterator = new CursorIterator(this);
    iterator.init();
    return iterator;
  }
}

export class Reader {
  parent: ReadCursor;
  size: number;
  startPosition: number;
  relativePosition: number;

  constructor(parent: ReadCursor, size: number, startPosition: number, relativePosition: number) {
    this.parent = parent;
    this.size = size;
    this.startPosition = startPosition;
    this.relativePosition = relativePosition;
  }

  read(buffer: Uint8Array): number {
    if (this.size < this.relativePosition) throw new EndOfStreamException();
    this.parent.db.core.seek(this.startPosition + this.relativePosition);
    const readSize = Math.min(buffer.length, this.size - this.relativePosition);
    if (readSize === 0) return -1;
    const reader = this.parent.db.core.reader();
    const tempBuffer = new Uint8Array(readSize);
    reader.readFully(tempBuffer);
    buffer.set(tempBuffer);
    this.relativePosition += readSize;
    return readSize;
  }

  readFully(buffer: Uint8Array): void {
    if (this.size < this.relativePosition || this.size - this.relativePosition < buffer.length) {
      throw new EndOfStreamException();
    }
    this.parent.db.core.seek(this.startPosition + this.relativePosition);
    const reader = this.parent.db.core.reader();
    reader.readFully(buffer);
    this.relativePosition += buffer.length;
  }

  readByte(): number {
    const bytes = new Uint8Array(1);
    this.readFully(bytes);
    return bytes[0];
  }

  readShort(): number {
    const readSize = 2;
    const bytes = new Uint8Array(readSize);
    this.readFully(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getInt16(0, false);
  }

  readInt(): number {
    const readSize = 4;
    const bytes = new Uint8Array(readSize);
    this.readFully(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getInt32(0, false);
  }

  readLong(): number {
    const readSize = 8;
    const bytes = new Uint8Array(readSize);
    this.readFully(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Number(view.getBigInt64(0, false));
  }

  seek(position: number): void {
    if (position > this.size) {
      throw new InvalidOffsetException();
    }
    this.relativePosition = position;
  }
}

class IteratorLevel {
  position: number;
  block: Slot[];
  index: number;

  constructor(position: number, block: Slot[], index: number) {
    this.position = position;
    this.block = block;
    this.index = index;
  }
}

export class CursorIterator {
  cursor: ReadCursor;
  size: number = 0;
  index: number = 0;
  private stack: IteratorLevel[] = [];
  private nextCursorMaybe: ReadCursor | null = null;

  constructor(cursor: ReadCursor) {
    this.cursor = cursor;
  }

  // resolve a possibly-negative start index against `size` to a 0-based rank.
  // negatives count from the end (-1 is the last entry); anything out of range
  // returns -1 (yield nothing).
  private static resolveStartIndex(index: number, size: number): number {
    const resolved = index < 0 ? index + size : index;
    if (resolved < 0 || resolved >= size) return -1;
    return resolved;
  }

  // start a sorted-map iterator at the entry with rank startIndex (the count descent),
  // iterating in key order from there. negative indexes count from the end.
  static initSortedFromIndex(cursor: ReadCursor, startIndex: number): CursorIterator {
    const it = new CursorIterator(cursor);
    // an unwritten map is NONE (like iterator()): yield nothing
    if (cursor.slotPtr.slot.tag === Tag.NONE) {
      return it;
    }
    const total = cursor.count();
    const idx = CursorIterator.resolveStartIndex(startIndex, total);
    if (idx < 0) {
      return it;
    }
    const rootPtr = CursorIterator.sortedRootPtr(cursor);
    it.size = total;
    it.index = idx;
    it.stack = CursorIterator.sortedStackFromIndex(cursor, rootPtr, idx);
    return it;
  }

  // start an array-list iterator at startIndex, descending the radix trie
  // straight to that index. negatives count from the end; out of range (or an
  // unwritten list) yields nothing.
  static initArrayListFromIndex(cursor: ReadCursor, startIndex: number): CursorIterator {
    const it = new CursorIterator(cursor);
    if (cursor.slotPtr.slot.tag !== Tag.ARRAY_LIST) {
      return it;
    }
    cursor.db.core.seek(Number(cursor.slotPtr.slot.value));
    const reader = cursor.db.core.reader();
    const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = ArrayListHeader.fromBytes(headerBytes);
    const idx = CursorIterator.resolveStartIndex(startIndex, header.size);
    if (idx < 0) {
      return it;
    }
    const lastKey = header.size - 1;
    const shift = lastKey < SLOT_COUNT ? 0 : Math.floor(Math.log(lastKey) / Math.log(SLOT_COUNT));
    it.size = header.size;
    it.index = idx;
    it.stack = CursorIterator.arrayListStackFromIndex(cursor, header.ptr, idx, shift);
    return it;
  }

  // start a linked-array-list iterator at startIndex, descending the
  // count-augmented b-tree straight to that index. negatives count from the end.
  static initLinkedArrayListFromIndex(cursor: ReadCursor, startIndex: number): CursorIterator {
    const it = new CursorIterator(cursor);
    if (cursor.slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) {
      return it;
    }
    cursor.db.core.seek(Number(cursor.slotPtr.slot.value));
    const reader = cursor.db.core.reader();
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);
    const idx = CursorIterator.resolveStartIndex(startIndex, header.size);
    if (idx < 0) {
      return it;
    }
    it.size = header.size;
    it.index = idx;
    it.stack = CursorIterator.btreeStackFromIndex(cursor, header.rootPtr, idx);
    return it;
  }

  // start a sorted-map iterator at the first entry with key >= startKey
  static initSortedFromKey(cursor: ReadCursor, startKey: Uint8Array): CursorIterator {
    const it = new CursorIterator(cursor);
    if (cursor.slotPtr.slot.tag === Tag.NONE) {
      return it;
    }
    const total = cursor.count();
    const rootPtr = CursorIterator.sortedRootPtr(cursor);
    const built = CursorIterator.sortedStackFromKey(cursor, rootPtr, startKey);
    it.size = total;
    it.index = built.before;
    it.stack = built.stack;
    return it;
  }

  private static sortedRootPtr(cursor: ReadCursor): number {
    switch (cursor.slotPtr.slot.tag) {
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET:
        break;
      default:
        throw new UnexpectedTagException();
    }
    cursor.db.core.seek(Number(cursor.slotPtr.slot.value));
    const reader = cursor.db.core.reader();
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);
    return header.rootPtr;
  }

  private static sortedStackFromIndex(cursor: ReadCursor, rootPtr: number, startIndex: number): IteratorLevel[] {
    const stack: IteratorLevel[] = [];
    let nodePtr = rootPtr;
    let rem = startIndex;
    while (true) {
      const node = cursor.db.readSortedNode(nodePtr);
      const position = nodePtr + BTREE_NODE_HEADER_SIZE;
      if (node.kind === BTreeNodeKind.LEAF) {
        stack.push(new IteratorLevel(position, node.entries, rem));
        return stack;
      } else {
        let i = 0;
        while (i + 1 < node.num && rem >= node.counts[i]) {
          rem -= node.counts[i];
          i++;
        }
        stack.push(new IteratorLevel(position, node.children, i));
        nodePtr = Number(node.children[i].value);
      }
    }
  }

  // descend the array-list radix trie to startIndex, pushing one IteratorLevel
  // per tier with its index set to that tier's child slot. nextInternal then
  // walks forward from there.
  private static arrayListStackFromIndex(cursor: ReadCursor, rootPtr: number, startIndex: number, shift: number): IteratorLevel[] {
    const stack: IteratorLevel[] = [];
    let pos = rootPtr;
    let sh = shift;
    while (true) {
      const block = CursorIterator.readSlotBlock(cursor, pos);
      const i = (startIndex >>> (sh * BIT_COUNT)) & (SLOT_COUNT - 1);
      stack.push(new IteratorLevel(pos, block, i));
      if (sh === 0) return stack;
      // every tier above the leaf is a populated INDEX slot for any
      // startIndex < size, so this child always exists
      pos = Number(block[i].value);
      sh -= 1;
    }
  }

  // descend the linked-array-list count b-tree to startIndex; the positional
  // analog of sortedStackFromIndex (no separator keys).
  private static btreeStackFromIndex(cursor: ReadCursor, rootPtr: number, startIndex: number): IteratorLevel[] {
    const stack: IteratorLevel[] = [];
    let nodePtr = rootPtr;
    let rem = startIndex;
    while (true) {
      const node = cursor.db.readBTreeNode(nodePtr);
      const position = nodePtr + BTREE_NODE_HEADER_SIZE;
      if (node.kind === BTreeNodeKind.LEAF) {
        stack.push(new IteratorLevel(position, node.values, rem));
        return stack;
      } else {
        let i = 0;
        while (i + 1 < node.num && rem >= node.counts[i]) {
          rem -= node.counts[i];
          i++;
        }
        stack.push(new IteratorLevel(position, node.children, i));
        nodePtr = Number(node.children[i].value);
      }
    }
  }

  private static sortedStackFromKey(
    cursor: ReadCursor,
    rootPtr: number,
    key: Uint8Array
  ): { stack: IteratorLevel[]; before: number } {
    const stack: IteratorLevel[] = [];
    let nodePtr = rootPtr;
    let before = 0;
    while (true) {
      const node = cursor.db.readSortedNode(nodePtr);
      const position = nodePtr + BTREE_NODE_HEADER_SIZE;
      if (node.kind === BTreeNodeKind.LEAF) {
        let li = node.num;
        for (let j = 0; j < node.num; j++) {
          const kv = cursor.db.readKvPair(node.entries[j]);
          if (cursor.db.compareKey(kv.keySlot, key) >= 0) {
            li = j;
            break;
          }
        }
        before += li;
        stack.push(new IteratorLevel(position, node.entries, li));
        return { stack, before };
      } else {
        let i = 0;
        while (i + 1 < node.num && cursor.db.compareKey(node.separators[i + 1], key) <= 0) {
          before += node.counts[i];
          i++;
        }
        stack.push(new IteratorLevel(position, node.children, i));
        nodePtr = Number(node.children[i].value);
      }
    }
  }

  init(): void {
    switch (this.cursor.slotPtr.slot.tag) {
      case Tag.NONE:
        this.size = 0;
        this.index = 0;
        this.stack = [];
        break;
      case Tag.ARRAY_LIST: {
        const position = Number(this.cursor.slotPtr.slot.value);
        this.cursor.db.core.seek(position);
        const reader = this.cursor.db.core.reader();
        const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
        reader.readFully(headerBytes);
        const header = ArrayListHeader.fromBytes(headerBytes);
        this.size = this.cursor.count();
        this.index = 0;
        this.stack = this.initStack(this.cursor, header.ptr);
        break;
      }
      case Tag.LINKED_ARRAY_LIST:
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET: {
        // backed by a b-tree: read the header, then walk from the root node's
        // value/child slots (skipping its kind+num header)
        const position = Number(this.cursor.slotPtr.slot.value);
        this.cursor.db.core.seek(position);
        const reader = this.cursor.db.core.reader();
        const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
        reader.readFully(headerBytes);
        const header = BTreeHeader.fromBytes(headerBytes);
        this.size = this.cursor.count();
        this.index = 0;
        this.stack = this.initStack(this.cursor, header.rootPtr + BTREE_NODE_HEADER_SIZE);
        break;
      }
      case Tag.HASH_MAP:
      case Tag.HASH_SET:
        this.size = 0;
        this.index = 0;
        this.stack = this.initStack(this.cursor, Number(this.cursor.slotPtr.slot.value));
        break;
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET:
        this.size = 0;
        this.index = 0;
        this.stack = this.initStack(this.cursor, Number(this.cursor.slotPtr.slot.value) + 8);
        break;
      default:
        throw new UnexpectedTagException();
    }
  }

  // read a 16-slot index block (the iterable structures all use 9-byte slots in
  // their index/node blocks)
  static readSlotBlock(cursor: ReadCursor, position: number): Slot[] {
    cursor.db.core.seek(position);
    const reader = cursor.db.core.reader();
    const indexBlockBytes = new Uint8Array(INDEX_BLOCK_SIZE);
    reader.readFully(indexBlockBytes);

    const indexBlock: Slot[] = new Array(SLOT_COUNT);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slotBytes = indexBlockBytes.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH);
      indexBlock[i] = Slot.fromBytes(slotBytes);
    }
    return indexBlock;
  }

  private initStack(cursor: ReadCursor, position: number): IteratorLevel[] {
    return [new IteratorLevel(position, CursorIterator.readSlotBlock(cursor, position), 0)];
  }

  hasNext(): boolean {
    switch (this.cursor.slotPtr.slot.tag) {
      case Tag.NONE:
        return false;
      case Tag.ARRAY_LIST:
        return this.index < this.size;
      case Tag.LINKED_ARRAY_LIST:
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET:
        return this.index < this.size;
      case Tag.HASH_MAP:
      case Tag.HASH_SET:
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET:
        if (this.nextCursorMaybe === null) {
          this.nextCursorMaybe = this.nextInternal(0);
        }
        return this.nextCursorMaybe !== null;
      default:
        return false;
    }
  }

  next(): ReadCursor | null {
    switch (this.cursor.slotPtr.slot.tag) {
      case Tag.NONE:
        return null;
      case Tag.ARRAY_LIST:
        if (!(this.hasNext())) return null;
        this.index += 1;
        return this.nextInternal(0);
      case Tag.LINKED_ARRAY_LIST:
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET:
        if (!(this.hasNext())) return null;
        this.index += 1;
        // b-tree nodes have a kind+num header before their slots, so child pointers
        // are offset by BTREE_NODE_HEADER_SIZE
        return this.nextInternal(BTREE_NODE_HEADER_SIZE);
      case Tag.HASH_MAP:
      case Tag.HASH_SET:
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET:
        if (this.nextCursorMaybe !== null) {
          const nextCursor = this.nextCursorMaybe;
          this.nextCursorMaybe = null;
          return nextCursor;
        } else {
          return this.nextInternal(0);
        }
      default:
        throw new UnexpectedTagException();
    }
  }

  private nextInternal(nodeOffset: number): ReadCursor | null {
    while (this.stack.length > 0) {
      const level = this.stack[this.stack.length - 1];
      if (level.index === level.block.length) {
        this.stack.pop();
        if (this.stack.length > 0) {
          this.stack[this.stack.length - 1].index += 1;
        }
        continue;
      } else {
        const nextSlot = level.block[level.index];
        if (nextSlot.tag === Tag.INDEX) {
          // nodeOffset skips a b-tree node's kind+num header
          const nextPos = Number(nextSlot.value) + nodeOffset;
          this.stack.push(new IteratorLevel(nextPos, CursorIterator.readSlotBlock(this.cursor, nextPos), 0));
          continue;
        } else {
          this.stack[this.stack.length - 1].index += 1;
          if (!nextSlot.empty()) {
            const position = level.position + level.index * Slot.LENGTH;
            return new ReadCursor(new SlotPointer(position, nextSlot), this.cursor.db);
          } else {
            continue;
          }
        }
      }
    }
    return null;
  }
}

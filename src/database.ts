import type { Core } from './core.js';
import { Hasher } from './hasher.js';
import { Tag, tagValueOf } from './tag.js';
import { Slot } from './slot.js';
import { SlotPointer } from './slot-pointer.js';
import {
  InvalidDatabaseException,
  InvalidVersionException,
  InvalidHashSizeException,
  KeyNotFoundException,
  WriteNotAllowedException,
  UnexpectedTagException,
  CursorNotWriteableException,
  ExpectedTxStartException,
  KeyOffsetExceededException,
  PathPartMustBeAtEndException,
  InvalidTopLevelTypeException,
  ExpectedUnsignedLongException,
  NoAvailableSlotsException,
  MustSetNewSlotsToFullException,
  EmptySlotException,
  ExpectedRootNodeException,
  UnreachableException,
  MaxShiftExceededException,
  InvalidBTreeNodeException,
  InvalidBTreeNodeKindException,
} from './exceptions.js';
import { Bytes, Float, Int, Uint, type WriteableData } from './writeable-data.js';
import { WriteCursor } from './write-cursor.js';

export const VERSION = 0;
export const MAGIC_NUMBER = new Uint8Array([0x78, 0x69, 0x74]); // 'xit'
export const BIT_COUNT = 4;
export const SLOT_COUNT = 1 << BIT_COUNT;
export const MASK = BigInt(SLOT_COUNT - 1);
export const INDEX_BLOCK_SIZE = Slot.LENGTH * SLOT_COUNT;
export const MAX_BRANCH_LENGTH = 16;
// b-tree (backs LinkedArrayList): nodes hold up to BTREE_SLOT_COUNT entries
export const BTREE_SLOT_COUNT = SLOT_COUNT; // max entries per leaf / children per branch
export const BTREE_SPLIT_COUNT = Math.floor((BTREE_SLOT_COUNT + 1) / 2); // left side of a split
// on-disk node block: [kind: u8][num: u8] followed by, for a leaf, BTREE_SLOT_COUNT
// value slots; for a branch, BTREE_SLOT_COUNT child slots then BTREE_SLOT_COUNT u64
// subtree counts
export const BTREE_NODE_HEADER_SIZE = 2;
export const BTREE_LEAF_BLOCK_SIZE = BTREE_NODE_HEADER_SIZE + Slot.LENGTH * BTREE_SLOT_COUNT;
export const BTREE_BRANCH_BLOCK_SIZE = BTREE_NODE_HEADER_SIZE + (Slot.LENGTH + 8) * BTREE_SLOT_COUNT;

export enum WriteMode {
  READ_ONLY,
  READ_WRITE,
}

// Header
export class Header {
  static readonly LENGTH = 12;

  constructor(
    public hashId: number,
    public hashSize: number,
    public version: number,
    public tag: Tag,
    public magicNumber: Uint8Array
  ) {}

  toBytes(): Uint8Array {
    const buffer = new ArrayBuffer(Header.LENGTH);
    const view = new DataView(buffer);
    const arr = new Uint8Array(buffer);
    arr.set(this.magicNumber, 0);
    view.setUint8(3, this.tag);
    view.setInt16(4, this.version, false);
    view.setInt16(6, this.hashSize, false);
    view.setInt32(8, this.hashId, false);
    return arr;
  }

  static read(core: Core): Header {
    const reader = core.reader();
    const magicNumber = new Uint8Array(3);
    reader.readFully(magicNumber);
    const tagByte = reader.readByte();
    const tag = tagValueOf(tagByte & 0b0111_1111);
    const version = reader.readShort();
    const hashSize = reader.readShort();
    const hashId = reader.readInt();
    return new Header(hashId, hashSize, version, tag, magicNumber);
  }

  write(core: Core): void {
    const writer = core.writer();
    writer.write(this.toBytes());
  }

  validate(): void {
    if (!arraysEqual(this.magicNumber, MAGIC_NUMBER)) {
      throw new InvalidDatabaseException();
    }
    if (this.version > VERSION) {
      throw new InvalidVersionException();
    }
  }

  withTag(tag: Tag): Header {
    return new Header(this.hashId, this.hashSize, this.version, tag, this.magicNumber);
  }
}

// ArrayListHeader
export class ArrayListHeader {
  static readonly LENGTH = 16;

  constructor(public ptr: number, public size: number) {}

  toBytes(): Uint8Array {
    const buffer = new ArrayBuffer(ArrayListHeader.LENGTH);
    const view = new DataView(buffer);
    view.setBigInt64(0, BigInt(this.size), false);
    view.setBigInt64(8, BigInt(this.ptr), false);
    return new Uint8Array(buffer);
  }

  static fromBytes(bytes: Uint8Array): ArrayListHeader {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = Number(view.getBigInt64(0, false));
    checkLong(size);
    const ptr = Number(view.getBigInt64(8, false));
    checkLong(ptr);
    return new ArrayListHeader(ptr, size);
  }

  withPtr(ptr: number): ArrayListHeader {
    return new ArrayListHeader(ptr, this.size);
  }
}

// TopLevelArrayListHeader
export class TopLevelArrayListHeader {
  static readonly LENGTH = 8 + ArrayListHeader.LENGTH;

  constructor(public fileSize: number, public parent: ArrayListHeader) {}

  toBytes(): Uint8Array {
    const buffer = new ArrayBuffer(TopLevelArrayListHeader.LENGTH);
    const view = new DataView(buffer);
    const arr = new Uint8Array(buffer);
    arr.set(this.parent.toBytes(), 0);
    view.setBigInt64(ArrayListHeader.LENGTH, BigInt(this.fileSize), false);
    return arr;
  }
}

// BTreeHeader: a root pointer plus the element count (backs LinkedArrayList)
export class BTreeHeader {
  static readonly LENGTH = 16;

  constructor(public rootPtr: number, public size: number) {}

  toBytes(): Uint8Array {
    const buffer = new ArrayBuffer(BTreeHeader.LENGTH);
    const view = new DataView(buffer);
    view.setBigInt64(0, BigInt(this.size), false);
    view.setBigInt64(8, BigInt(this.rootPtr), false);
    return new Uint8Array(buffer);
  }

  static fromBytes(bytes: Uint8Array): BTreeHeader {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = Number(view.getBigInt64(0, false));
    checkLong(size);
    const rootPtr = Number(view.getBigInt64(8, false));
    checkLong(rootPtr);
    return new BTreeHeader(rootPtr, size);
  }
}

// KeyValuePair
export class KeyValuePair {
  constructor(
    public valueSlot: Slot,
    public keySlot: Slot,
    public hash: Uint8Array
  ) {}

  static length(hashSize: number): number {
    return hashSize + Slot.LENGTH * 2;
  }

  toBytes(): Uint8Array {
    const buffer = new Uint8Array(KeyValuePair.length(this.hash.length));
    buffer.set(this.hash, 0);
    buffer.set(this.keySlot.toBytes(), this.hash.length);
    buffer.set(this.valueSlot.toBytes(), this.hash.length + Slot.LENGTH);
    return buffer;
  }

  static fromBytes(bytes: Uint8Array, hashSize: number): KeyValuePair {
    const hash = bytes.slice(0, hashSize);
    const keySlotBytes = bytes.slice(hashSize, hashSize + Slot.LENGTH);
    const keySlot = Slot.fromBytes(keySlotBytes);
    const valueSlotBytes = bytes.slice(hashSize + Slot.LENGTH, hashSize + Slot.LENGTH * 2);
    const valueSlot = Slot.fromBytes(valueSlotBytes);
    return new KeyValuePair(valueSlot, keySlot, hash);
  }
}

// sorted-by-position B-tree node. a leaf holds value slots; a branch holds child
// slots (.index) plus a per-child u64 subtree count.
export enum BTreeNodeKind {
  LEAF = 0,
  BRANCH = 1,
}

export class BTreeNode {
  values: Slot[] = new Array(BTREE_SLOT_COUNT); // leaf
  children: Slot[] = new Array(BTREE_SLOT_COUNT); // branch
  counts: number[] = new Array(BTREE_SLOT_COUNT).fill(0); // branch

  constructor(public kind: BTreeNodeKind, public num: number) {
    for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
      this.values[i] = new Slot();
      this.children[i] = new Slot();
    }
  }

  subtreeCount(): number {
    if (this.kind === BTreeNodeKind.LEAF) return this.num;
    let total = 0;
    for (let i = 0; i < this.num; i++) total += this.counts[i];
    return total;
  }
}

// a node pointer plus the element count of its subtree (the right sibling of a split)
export class BTreeNodeRef {
  constructor(public nodePtr: number, public count: number) {}
}

export class BTreeInsertResult {
  constructor(
    public nodePtr: number,
    public count: number,
    public valuePosition: number,
    public split: BTreeNodeRef | null
  ) {}
}

export class BTreeWriteSlot {
  constructor(public nodePtr: number, public valuePosition: number, public slot: Slot) {}
}

export class BTreeJoinResult {
  constructor(public nodePtr: number, public count: number, public split: BTreeNodeRef | null) {}
}

export class BTreeSplitResult {
  constructor(public left: number, public right: number) {}
}

// PathPart types (discriminated union)
export type PathPart =
  | ArrayListInit
  | ArrayListGet
  | ArrayListAppend
  | ArrayListSlice
  | LinkedArrayListInit
  | LinkedArrayListGet
  | LinkedArrayListAppend
  | LinkedArrayListSlice
  | LinkedArrayListConcat
  | LinkedArrayListInsert
  | LinkedArrayListRemove
  | HashMapInit
  | HashMapGet
  | HashMapRemove
  | WriteData
  | Context;

export interface PathPartBase {
  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer;
}

// HashMapGetTarget types
export type HashMapGetTarget = HashMapGetKVPair | HashMapGetKey | HashMapGetValue;

export class HashMapGetKVPair {
  readonly kind = 'kv_pair';
  constructor(public hash: Uint8Array) {}
}

export class HashMapGetKey {
  readonly kind = 'key';
  constructor(public hash: Uint8Array) {}
}

export class HashMapGetValue {
  readonly kind = 'value';
  constructor(public hash: Uint8Array) {}
}

// ContextFunction type
export type ContextFunction = (cursor: any) => void;

// PathPart implementations
export class ArrayListInit implements PathPartBase {
  readonly kind = 'ArrayListInit';

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();

    if (isTopLevel) {
      const writer = db.core.writer();

      if (db.header.tag === Tag.NONE) {
        db.core.seek(Header.LENGTH);
        const arrayListPtr = Header.LENGTH + TopLevelArrayListHeader.LENGTH;
        writer.write(
          new TopLevelArrayListHeader(0, new ArrayListHeader(arrayListPtr, 0)).toBytes()
        );
        writer.write(new Uint8Array(INDEX_BLOCK_SIZE));

        db.core.seek(0);
        db.header = db.header.withTag(Tag.ARRAY_LIST);
        writer.write(db.header.toBytes());
      }

      const nextSlotPtr = slotPtr.withSlot(slotPtr.slot.withTag(Tag.ARRAY_LIST));
      return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
    }

    if (slotPtr.position === null) throw new CursorNotWriteableException();
    const position = slotPtr.position;

    switch (slotPtr.slot.tag) {
      case Tag.NONE: {
        const writer = db.core.writer();
        let arrayListStart = db.core.length();
        db.core.seek(arrayListStart);
        const arrayListPtr = arrayListStart + ArrayListHeader.LENGTH;
        writer.write(new ArrayListHeader(arrayListPtr, 0).toBytes());
        writer.write(new Uint8Array(INDEX_BLOCK_SIZE));

        const nextSlotPtr = new SlotPointer(position, new Slot(arrayListStart, Tag.ARRAY_LIST));
        db.core.seek(position);
        writer.write(nextSlotPtr.slot.toBytes());
        return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
      }
      case Tag.ARRAY_LIST: {
        const reader = db.core.reader();
        const writer = db.core.writer();

        let arrayListStart = Number(slotPtr.slot.value);

        if (db.txStart !== null) {
          if (arrayListStart < db.txStart) {
            db.core.seek(arrayListStart);
            const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
            reader.readFully(headerBytes);
            const header = ArrayListHeader.fromBytes(headerBytes);
            db.core.seek(header.ptr);
            const arrayListIndexBlock = new Uint8Array(INDEX_BLOCK_SIZE);
            reader.readFully(arrayListIndexBlock);

            arrayListStart = db.core.length();
            db.core.seek(arrayListStart);
            const nextArrayListPtr = arrayListStart + ArrayListHeader.LENGTH;
            const newHeader = header.withPtr(nextArrayListPtr);
            writer.write(newHeader.toBytes());
            writer.write(arrayListIndexBlock);
          }
        } else if (db.header.tag === Tag.ARRAY_LIST) {
          throw new ExpectedTxStartException();
        }

        const nextSlotPtr = new SlotPointer(position, new Slot(arrayListStart, Tag.ARRAY_LIST));
        db.core.seek(position);
        writer.write(nextSlotPtr.slot.toBytes());
        return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
      }
      default:
        throw new UnexpectedTagException();
    }
  }
}

export class ArrayListGet implements PathPartBase {
  readonly kind = 'ArrayListGet';
  constructor(public index: number) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    const tag = isTopLevel ? db.header.tag : slotPtr.slot.tag;
    switch (tag) {
      case Tag.NONE:
        throw new KeyNotFoundException();
      case Tag.ARRAY_LIST:
        break;
      default:
        throw new UnexpectedTagException();
    }

    const nextArrayListStart = Number(slotPtr.slot.value);
    let index = this.index;

    db.core.seek(nextArrayListStart);
    const reader = db.core.reader();
    const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = ArrayListHeader.fromBytes(headerBytes);
    if (index >= header.size || index < -header.size) {
      throw new KeyNotFoundException();
    }

    const key = index < 0 ? header.size - Math.abs(index) : index;
    const lastKey = header.size - 1;
    const shift = lastKey < SLOT_COUNT ? 0 : Math.floor(Math.log(lastKey) / Math.log(SLOT_COUNT));
    const finalSlotPtr = db.readArrayListSlot(header.ptr, key, shift, writeMode, isTopLevel);

    return db.readSlotPointer(writeMode, path, pathI + 1, finalSlotPtr);
  }
}

export class ArrayListAppend implements PathPartBase {
  readonly kind = 'ArrayListAppend';

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();

    const tag = isTopLevel ? db.header.tag : slotPtr.slot.tag;
    if (tag !== Tag.ARRAY_LIST) throw new UnexpectedTagException();

    const reader = db.core.reader();
    const nextArrayListStart = Number(slotPtr.slot.value);

    db.core.seek(nextArrayListStart);
    const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const origHeader = ArrayListHeader.fromBytes(headerBytes);

    const appendResult = db.readArrayListSlotAppend(origHeader, writeMode, isTopLevel);
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, appendResult.slotPtr);

    const writer = db.core.writer();
    if (isTopLevel) {
      db.core.flush();
      const fileSize = db.core.length();
      const header = new TopLevelArrayListHeader(fileSize, appendResult.header);
      db.core.seek(nextArrayListStart);
      writer.write(header.toBytes());
    } else {
      db.core.seek(nextArrayListStart);
      writer.write(appendResult.header.toBytes());
    }

    return finalSlotPtr;
  }
}

export class ArrayListSlice implements PathPartBase {
  readonly kind = 'ArrayListSlice';
  constructor(public size: number) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.ARRAY_LIST) throw new UnexpectedTagException();

    const reader = db.core.reader();
    const nextArrayListStart = Number(slotPtr.slot.value);

    db.core.seek(nextArrayListStart);
    const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const origHeader = ArrayListHeader.fromBytes(headerBytes);

    const sliceHeader = db.readArrayListSlice(origHeader, this.size);
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);

    const writer = db.core.writer();
    db.core.seek(nextArrayListStart);
    writer.write(sliceHeader.toBytes());

    return finalSlotPtr;
  }
}

export class LinkedArrayListInit implements PathPartBase {
  readonly kind = 'LinkedArrayListInit';

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (isTopLevel) throw new InvalidTopLevelTypeException();
    if (slotPtr.position === null) throw new CursorNotWriteableException();
    const position = slotPtr.position;

    const writer = db.core.writer();

    switch (slotPtr.slot.tag) {
      case Tag.NONE: {
        // create an empty tree: a single empty leaf plus a header
        const rootPtr = db.writeBTreeNode(new BTreeNode(BTreeNodeKind.LEAF, 0));
        const headerPtr = db.core.length();
        db.core.seek(headerPtr);
        writer.write(new BTreeHeader(rootPtr, 0).toBytes());
        const nextSlotPtr = new SlotPointer(position, new Slot(headerPtr, Tag.LINKED_ARRAY_LIST));
        db.core.seek(position);
        writer.write(nextSlotPtr.slot.toBytes());
        return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
      }
      case Tag.LINKED_ARRAY_LIST: {
        let headerPtr = Number(slotPtr.slot.value);
        // copy the header into this transaction unless it was made in it, so past
        // moments still pointing at the old header are unaffected. b-tree nodes are
        // always appended, so only the header (updated in place by later operations
        // in this tx) needs copying.
        if (db.txStart !== null) {
          if (headerPtr < db.txStart) {
            const reader = db.core.reader();
            db.core.seek(headerPtr);
            const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
            reader.readFully(headerBytes);
            headerPtr = db.core.length();
            db.core.seek(headerPtr);
            writer.write(headerBytes);
          }
        } else if (db.header.tag === Tag.ARRAY_LIST) {
          throw new ExpectedTxStartException();
        }
        const nextSlotPtr = new SlotPointer(position, new Slot(headerPtr, Tag.LINKED_ARRAY_LIST));
        db.core.seek(position);
        writer.write(nextSlotPtr.slot.toBytes());
        return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
      }
      default:
        throw new UnexpectedTagException();
    }
  }
}

export class LinkedArrayListGet implements PathPartBase {
  readonly kind = 'LinkedArrayListGet';
  constructor(public index: number) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    switch (slotPtr.slot.tag) {
      case Tag.NONE:
        throw new KeyNotFoundException();
      case Tag.LINKED_ARRAY_LIST:
        break;
      default:
        throw new UnexpectedTagException();
    }

    const index = this.index;

    const headerPtr = Number(slotPtr.slot.value);
    const reader = db.core.reader();
    db.core.seek(headerPtr);
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);
    if (index >= header.size || index < -header.size) {
      throw new KeyNotFoundException();
    }
    const rank = index < 0 ? header.size - Math.abs(index) : index;

    if (writeMode === WriteMode.READ_ONLY) {
      const finalSlotPtr = db.readBTreeSlot(header.rootPtr, rank);
      return db.readSlotPointer(writeMode, path, pathI + 1, finalSlotPtr);
    } else {
      // path-copy down to the value slot so the write is persistent
      const writeSlot = db.btreeGetForWrite(header.rootPtr, rank);
      const finalSlotPtr = db.readSlotPointer(
        writeMode,
        path,
        pathI + 1,
        new SlotPointer(writeSlot.valuePosition, writeSlot.slot)
      );
      // the header only needs rewriting if the root actually moved (it stays put
      // when the whole path was already this-transaction)
      if (writeSlot.nodePtr !== header.rootPtr) {
        const writer = db.core.writer();
        db.core.seek(headerPtr);
        writer.write(new BTreeHeader(writeSlot.nodePtr, header.size).toBytes());
      }
      return finalSlotPtr;
    }
  }
}

export class LinkedArrayListAppend implements PathPartBase {
  readonly kind = 'LinkedArrayListAppend';

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    const headerPtr = Number(slotPtr.slot.value);
    const reader = db.core.reader();
    db.core.seek(headerPtr);
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);

    const result = db.btreeInsert(header.rootPtr, header.size);
    const newRootPtr = db.btreeGrowRoot(result);

    // fill in the value via the rest of the path
    const finalSlotPtr = db.readSlotPointer(
      writeMode,
      path,
      pathI + 1,
      new SlotPointer(result.valuePosition, new Slot())
    );

    // update header
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, header.size + 1).toBytes());

    return finalSlotPtr;
  }
}

export class LinkedArrayListSlice implements PathPartBase {
  readonly kind = 'LinkedArrayListSlice';
  constructor(public offset: number, public size: number) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    const headerPtr = Number(slotPtr.slot.value);
    const reader = db.core.reader();
    db.core.seek(headerPtr);
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);

    // bounds-checked without overflow (offset + size could wrap)
    if (this.offset > header.size || this.size > header.size - this.offset) {
      throw new KeyNotFoundException();
    }

    // slice = drop [0, offset) then keep [0, size) of what's left
    const afterOffset = db.btreeSplit(header.rootPtr, this.offset);
    const sliced = db.btreeSplit(afterOffset.right, this.size);
    const newRootPtr = sliced.left;
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);

    // update header
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, this.size).toBytes());

    return finalSlotPtr;
  }
}

export class LinkedArrayListConcat implements PathPartBase {
  readonly kind = 'LinkedArrayListConcat';
  constructor(public list: Slot) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();
    if (this.list.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    const headerPtr = Number(slotPtr.slot.value);
    const reader = db.core.reader();
    db.core.seek(headerPtr);
    const headerBytesA = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytesA);
    const headerA = BTreeHeader.fromBytes(headerBytesA);
    db.core.seek(Number(this.list.value));
    const headerBytesB = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytesB);
    const headerB = BTreeHeader.fromBytes(headerBytesB);

    // the join result shares subtrees with both operands (and the second operand
    // stays live), so freeze everything created so far: later in-place mutations
    // will then copy those nodes instead of overwriting a node that is still
    // referenced elsewhere.
    db.txStart = db.core.length();
    const newRootPtr = db.btreeJoin(headerA.rootPtr, headerB.rootPtr);
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);

    // update header
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, headerA.size + headerB.size).toBytes());

    return finalSlotPtr;
  }
}

export class LinkedArrayListInsert implements PathPartBase {
  readonly kind = 'LinkedArrayListInsert';
  constructor(public index: number) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    const headerPtr = Number(slotPtr.slot.value);
    const reader = db.core.reader();
    db.core.seek(headerPtr);
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);

    const index = this.index;
    if (index >= header.size || index < -header.size) {
      throw new KeyNotFoundException();
    }
    const rank = index < 0 ? header.size - Math.abs(index) : index;

    const result = db.btreeInsert(header.rootPtr, rank);
    const newRootPtr = db.btreeGrowRoot(result);

    const finalSlotPtr = db.readSlotPointer(
      writeMode,
      path,
      pathI + 1,
      new SlotPointer(result.valuePosition, new Slot())
    );

    // update header
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, header.size + 1).toBytes());

    return finalSlotPtr;
  }
}

export class LinkedArrayListRemove implements PathPartBase {
  readonly kind = 'LinkedArrayListRemove';
  constructor(public index: number) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    const headerPtr = Number(slotPtr.slot.value);
    const reader = db.core.reader();
    db.core.seek(headerPtr);
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);

    const index = this.index;
    if (index >= header.size || index < -header.size) {
      throw new KeyNotFoundException();
    }
    const rank = index < 0 ? header.size - Math.abs(index) : index;

    // remove = join the parts before and after the removed element
    const before = db.btreeSplit(header.rootPtr, rank);
    const after = db.btreeSplit(before.right, 1);
    const newRootPtr = db.btreeJoin(before.left, after.right);
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);

    // update header
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, header.size - 1).toBytes());

    return finalSlotPtr;
  }
}

export class HashMapInit implements PathPartBase {
  readonly kind = 'HashMapInit';
  constructor(public counted: boolean = false, public set: boolean = false) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();

    const tag = this.counted
      ? (this.set ? Tag.COUNTED_HASH_SET : Tag.COUNTED_HASH_MAP)
      : (this.set ? Tag.HASH_SET : Tag.HASH_MAP);

    if (isTopLevel) {
      const writer = db.core.writer();

      if (db.header.tag === Tag.NONE) {
        db.core.seek(Header.LENGTH);

        if (this.counted) {
          writer.writeLong(0);
        }

        writer.write(new Uint8Array(INDEX_BLOCK_SIZE));

        db.core.seek(0);
        db.header = db.header.withTag(tag);
        writer.write(db.header.toBytes());
      }

      const nextSlotPtr = slotPtr.withSlot(slotPtr.slot.withTag(tag));
      return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
    }

    if (slotPtr.position === null) throw new CursorNotWriteableException();
    const position = slotPtr.position;

    switch (slotPtr.slot.tag) {
      case Tag.NONE: {
        const writer = db.core.writer();
        const mapStart = db.core.length();
        db.core.seek(mapStart);
        if (this.counted) {
          writer.writeLong(0);
        }
        writer.write(new Uint8Array(INDEX_BLOCK_SIZE));

        const nextSlotPtr = new SlotPointer(position, new Slot(mapStart, tag));
        db.core.seek(position);
        writer.write(nextSlotPtr.slot.toBytes());
        return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
      }
      case Tag.HASH_MAP:
      case Tag.HASH_SET:
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET: {
        if (this.counted) {
          switch (slotPtr.slot.tag) {
            case Tag.COUNTED_HASH_MAP:
            case Tag.COUNTED_HASH_SET:
              break;
            default:
              throw new UnexpectedTagException();
          }
        } else {
          switch (slotPtr.slot.tag) {
            case Tag.HASH_MAP:
            case Tag.HASH_SET:
              break;
            default:
              throw new UnexpectedTagException();
          }
        }

        const reader = db.core.reader();
        const writer = db.core.writer();

        let mapStart = Number(slotPtr.slot.value);

        if (db.txStart !== null) {
          if (mapStart < db.txStart) {
            db.core.seek(mapStart);
            let mapCountMaybe: number | null = null;
            if (this.counted) {
              mapCountMaybe = reader.readLong();
            }
            const mapIndexBlock = new Uint8Array(INDEX_BLOCK_SIZE);
            reader.readFully(mapIndexBlock);

            mapStart = db.core.length();
            db.core.seek(mapStart);
            if (mapCountMaybe !== null) {
              writer.writeLong(mapCountMaybe);
            }
            writer.write(mapIndexBlock);
          }
        } else if (db.header.tag === Tag.ARRAY_LIST) {
          throw new ExpectedTxStartException();
        }

        const nextSlotPtr = new SlotPointer(position, new Slot(mapStart, tag));
        db.core.seek(position);
        writer.write(nextSlotPtr.slot.toBytes());
        return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
      }
      default:
        throw new UnexpectedTagException();
    }
  }
}

export class HashMapGet implements PathPartBase {
  readonly kind = 'HashMapGet';
  constructor(public target: HashMapGetTarget) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    let counted = false;
    switch (slotPtr.slot.tag) {
      case Tag.NONE:
        throw new KeyNotFoundException();
      case Tag.HASH_MAP:
      case Tag.HASH_SET:
        break;
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET:
        counted = true;
        break;
      default:
        throw new UnexpectedTagException();
    }

    const indexPos = counted ? Number(slotPtr.slot.value) + 8 : Number(slotPtr.slot.value);
    const hash = db.checkHash(this.target);
    const res = db.readMapSlot(indexPos, hash, 0, writeMode, isTopLevel, this.target);

    if (writeMode === WriteMode.READ_WRITE && counted && res.isEmpty) {
      const reader = db.core.reader();
      const writer = db.core.writer();
      db.core.seek(Number(slotPtr.slot.value));
      const mapCount = reader.readLong();
      db.core.seek(Number(slotPtr.slot.value));
      writer.writeLong(mapCount + 1);
    }

    return db.readSlotPointer(writeMode, path, pathI + 1, res.slotPtr);
  }
}

export class HashMapRemove implements PathPartBase {
  readonly kind = 'HashMapRemove';
  constructor(public hash: Uint8Array) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();

    let counted = false;
    switch (slotPtr.slot.tag) {
      case Tag.NONE:
        throw new KeyNotFoundException();
      case Tag.HASH_MAP:
      case Tag.HASH_SET:
        break;
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET:
        counted = true;
        break;
      default:
        throw new UnexpectedTagException();
    }

    const indexPos = counted ? Number(slotPtr.slot.value) + 8 : Number(slotPtr.slot.value);
    const hash = db.checkHashBytes(this.hash);

    let keyFound = true;
    try {
      db.removeMapSlot(indexPos, hash, 0, isTopLevel);
    } catch (e) {
      if (e instanceof KeyNotFoundException) {
        keyFound = false;
      } else {
        throw e;
      }
    }

    if (writeMode === WriteMode.READ_WRITE && counted && keyFound) {
      const reader = db.core.reader();
      const writer = db.core.writer();
      db.core.seek(Number(slotPtr.slot.value));
      const mapCount = reader.readLong();
      db.core.seek(Number(slotPtr.slot.value));
      writer.writeLong(mapCount - 1);
    }

    if (!keyFound) throw new KeyNotFoundException();

    return slotPtr;
  }
}

export class WriteData implements PathPartBase {
  readonly kind = 'WriteData';
  constructor(public data: WriteableData | null) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.position === null) throw new CursorNotWriteableException();
    const position = slotPtr.position;

    const writer = db.core.writer();

    const data = this.data;
    let slot: Slot;

    if (data === null) {
      slot = new Slot();
    } else if (data instanceof Slot) {
      slot = data;
    } else if (data instanceof Uint) {
      slot = new Slot(data.value, Tag.UINT);
    } else if (data instanceof Int) {
      slot = new Slot(data.value, Tag.INT);
    } else if (data instanceof Float) {
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setFloat64(0, data.value, false);
      const longValue = view.getBigInt64(0, false);
      slot = new Slot(longValue, Tag.FLOAT);
    } else if (data instanceof Bytes) {
      if (data.isShort()) {
        const buffer = new Uint8Array(8);
        buffer.set(data.value, 0);
        if (data.formatTag !== null) {
          buffer.set(data.formatTag, 6);
        }
        const view = new DataView(buffer.buffer);
        // Read 8 bytes big-endian as BigInt for full precision
        const longValue = view.getBigInt64(0, false);
        slot = new Slot(longValue, Tag.SHORT_BYTES, data.formatTag !== null);
      } else {
        const nextCursor = new WriteCursor(slotPtr, db);
        const cursorWriter = nextCursor.writer();
        cursorWriter.formatTag = data.formatTag;
        cursorWriter.write(data.value);
        cursorWriter.finish();
        slot = cursorWriter.slot;
      }
    } else {
      throw new Error('Unknown data type');
    }

    if (slot.tag === Tag.NONE) {
      slot = slot.withFull(true);
    }

    db.core.seek(position);
    writer.write(slot.toBytes());

    const nextSlotPtr = new SlotPointer(slotPtr.position, slot);
    return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
  }
}

export class Context implements PathPartBase {
  readonly kind = 'Context';
  constructor(public fn: ContextFunction) {}

  readSlotPointer(
    db: Database,
    isTopLevel: boolean,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (pathI !== path.length - 1) throw new PathPartMustBeAtEndException();

    const nextCursor = new WriteCursor(slotPtr, db);
    try {
      this.fn(nextCursor);
    } catch (e) {
      try {
        db.truncate();
      } catch (_) {}
      throw e;
    }
    return nextCursor.slotPtr;
  }
}

// HashMapGetResult
class HashMapGetResult {
  constructor(public slotPtr: SlotPointer, public isEmpty: boolean) {}
}

// ArrayListAppendResult
class ArrayListAppendResult {
  constructor(public header: ArrayListHeader, public slotPtr: SlotPointer) {}
}

// Helper functions
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function checkLong(n: number): number {
  if (n < 0) {
    throw new ExpectedUnsignedLongException();
  }
  return n;
}

function bigIntShiftRight(value: Uint8Array, bits: number): bigint {
  let result = 0n;
  for (let i = 0; i < value.length; i++) {
    result = (result << 8n) | BigInt(value[i]);
  }
  return result >> BigInt(bits);
}

// Database class
export class Database {
  public core: Core;
  public hasher: Hasher;
  public header!: Header;
  public txStart: number | null = null;

  constructor(core: Core, hasher: Hasher) {
    this.core = core;
    this.hasher = hasher;

    core.seek(0);
    if ((core.length()) === 0) {
      this.header = new Header(hasher.id, hasher.digestLength, VERSION, Tag.NONE, MAGIC_NUMBER);
      this.header.write(core);
      core.flush();
    } else {
      this.header = Header.read(core);
      this.header.validate();
      if (this.header.hashSize !== hasher.digestLength) {
        throw new InvalidHashSizeException();
      }
      this.truncate();
    }
  }

  rootCursor(): WriteCursor {
    // if the header tag is none, try re-reading it.
    // this may be necessary if the database was initialized on a different thread.
    if (this.header.tag === Tag.NONE) {
      this.core.seek(0);
      this.header = Header.read(this.core);
    }
    return new WriteCursor(
      new SlotPointer(null, new Slot(Header.LENGTH, this.header.tag)),
      this
    );
  }

  freeze(): void {
    if (this.txStart !== null) {
      this.txStart = this.core.length();
    } else {
      throw new ExpectedTxStartException();
    }
  }

  compact(targetCore: Core): Database {
    const offsetMap = new Map<number, number>();
    const hasher = new Hasher(this.hasher.algorithm, this.header.hashId);
    const target = new Database(targetCore, hasher);

    if (this.header.tag === Tag.NONE) return target;
    if (this.header.tag !== Tag.ARRAY_LIST) throw new UnexpectedTagException();

    // read source's top-level ArrayListHeader
    this.core.seek(Header.LENGTH);
    const sourceReader = this.core.reader();
    const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
    sourceReader.readFully(headerBytes);
    const sourceHeader = ArrayListHeader.fromBytes(headerBytes);

    if (sourceHeader.size === 0) return target;

    // read the last moment's slot
    const lastKey = sourceHeader.size - 1;
    const shift = lastKey < SLOT_COUNT ? 0 : Math.floor(Math.log(lastKey) / Math.log(SLOT_COUNT));
    const lastSlotPtr = this.readArrayListSlot(sourceHeader.ptr, lastKey, shift, WriteMode.READ_ONLY, true);
    const momentSlot = lastSlotPtr.slot;

    // write TopLevelArrayListHeader + root index block to target
    const targetWriter = targetCore.writer();
    targetCore.seek(Header.LENGTH);
    const targetArrayListPtr = Header.LENGTH + TopLevelArrayListHeader.LENGTH;
    targetWriter.write(
      new TopLevelArrayListHeader(0, new ArrayListHeader(targetArrayListPtr, 1)).toBytes()
    );
    targetWriter.write(new Uint8Array(INDEX_BLOCK_SIZE));

    // recursively remap the moment slot
    const remappedMoment = remapSlot(this.core, targetCore, this.header.hashSize, offsetMap, momentSlot);

    // write remapped moment slot into position 0 of target's root index block
    targetCore.seek(targetArrayListPtr);
    targetWriter.write(remappedMoment.toBytes());

    // update target's DatabaseHeader tag
    target.header = target.header.withTag(Tag.ARRAY_LIST);
    targetCore.seek(0);
    target.header.write(targetCore);

    // flush, update file_size, flush again
    targetCore.flush();
    const fileSize = targetCore.length();
    targetCore.seek(Header.LENGTH + ArrayListHeader.LENGTH);
    targetWriter.writeLong(fileSize);
    targetCore.flush();

    return target;
  }

  truncate(): void {
    if (this.header.tag !== Tag.ARRAY_LIST) return;

    const rootCursor = this.rootCursor();
    const listSize = rootCursor.count();

    if (listSize === 0) return;

    this.core.seek(Header.LENGTH + ArrayListHeader.LENGTH);
    const reader = this.core.reader();
    const headerFileSize = reader.readLong();

    if (headerFileSize === 0) return;

    const fileSize = this.core.length();

    if (fileSize === headerFileSize) return;

    try {
      this.core.setLength(headerFileSize);
    } catch (_) {}
  }

  checkHashBytes(hash: Uint8Array): Uint8Array {
    if (hash.length !== this.header.hashSize) {
      throw new InvalidHashSizeException();
    }
    return hash;
  }

  checkHash(target: HashMapGetTarget): Uint8Array {
    return this.checkHashBytes(target.hash);
  }

  readSlotPointer(
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (pathI === path.length) {
      if (writeMode === WriteMode.READ_ONLY && slotPtr.slot.tag === Tag.NONE) {
        throw new KeyNotFoundException();
      }
      return slotPtr;
    }

    const part = path[pathI];
    const isTopLevel = slotPtr.slot.value === BigInt(Header.LENGTH);

    const isTxStart = isTopLevel && this.header.tag === Tag.ARRAY_LIST && this.txStart === null;
    if (isTxStart) {
      this.txStart = this.core.length();
    }

    try {
      return part.readSlotPointer(this, isTopLevel, writeMode, path, pathI, slotPtr);
    } finally {
      if (isTxStart) {
        this.txStart = null;
      }
    }
  }

  // HashMap methods
  readMapSlot(
    indexPos: number,
    keyHash: Uint8Array,
    keyOffset: number,
    writeMode: WriteMode,
    isTopLevel: boolean,
    target: HashMapGetTarget
  ): HashMapGetResult {
    if (keyOffset > (this.header.hashSize * 8) / BIT_COUNT) {
      throw new KeyOffsetExceededException();
    }

    const reader = this.core.reader();
    const writer = this.core.writer();

    const i = Number(bigIntShiftRight(keyHash, keyOffset * BIT_COUNT) & MASK);
    const slotPos = indexPos + Slot.LENGTH * i;
    this.core.seek(slotPos);
    const slotBytes = new Uint8Array(Slot.LENGTH);
    reader.readFully(slotBytes);
    const slot = Slot.fromBytes(slotBytes);

    const ptr = Number(slot.value);

    switch (slot.tag) {
      case Tag.NONE: {
        switch (writeMode) {
          case WriteMode.READ_ONLY:
            throw new KeyNotFoundException();
          case WriteMode.READ_WRITE: {
            const hashPos = this.core.length();
            this.core.seek(hashPos);
            const keySlotPos = hashPos + this.header.hashSize;
            const valueSlotPos = keySlotPos + Slot.LENGTH;
            const kvPair = new KeyValuePair(new Slot(), new Slot(), keyHash);
            writer.write(kvPair.toBytes());

            const nextSlot = new Slot(hashPos, Tag.KV_PAIR);
            this.core.seek(slotPos);
            writer.write(nextSlot.toBytes());

            let nextSlotPtr: SlotPointer;
            if (target.kind === 'kv_pair') {
              nextSlotPtr = new SlotPointer(slotPos, nextSlot);
            } else if (target.kind === 'key') {
              nextSlotPtr = new SlotPointer(keySlotPos, kvPair.keySlot);
            } else {
              nextSlotPtr = new SlotPointer(valueSlotPos, kvPair.valueSlot);
            }
            return new HashMapGetResult(nextSlotPtr, true);
          }
          default:
            throw new UnreachableException();
        }
      }
      case Tag.INDEX: {
        let nextPtr = ptr;
        if (writeMode === WriteMode.READ_WRITE && !isTopLevel) {
          if (this.txStart !== null) {
            if (nextPtr < this.txStart) {
              this.core.seek(ptr);
              const indexBlock = new Uint8Array(INDEX_BLOCK_SIZE);
              reader.readFully(indexBlock);

              nextPtr = this.core.length();
              this.core.seek(nextPtr);
              writer.write(indexBlock);

              this.core.seek(slotPos);
              writer.write(new Slot(nextPtr, Tag.INDEX).toBytes());
            }
          } else if (this.header.tag === Tag.ARRAY_LIST) {
            throw new ExpectedTxStartException();
          }
        }
        return this.readMapSlot(nextPtr, keyHash, keyOffset + 1, writeMode, isTopLevel, target);
      }
      case Tag.KV_PAIR: {
        this.core.seek(ptr);
        const kvPairBytes = new Uint8Array(KeyValuePair.length(this.header.hashSize));
        reader.readFully(kvPairBytes);
        const kvPair = KeyValuePair.fromBytes(kvPairBytes, this.header.hashSize);

        if (arraysEqual(kvPair.hash, keyHash)) {
          if (writeMode === WriteMode.READ_WRITE && !isTopLevel) {
            if (this.txStart !== null) {
              if (ptr < this.txStart) {
                const hashPos = this.core.length();
                this.core.seek(hashPos);
                const keySlotPos = hashPos + this.header.hashSize;
                const valueSlotPos = keySlotPos + Slot.LENGTH;
                writer.write(kvPair.toBytes());

                const nextSlot = new Slot(hashPos, Tag.KV_PAIR);
                this.core.seek(slotPos);
                writer.write(nextSlot.toBytes());

                let nextSlotPtr: SlotPointer;
                if (target.kind === 'kv_pair') {
                  nextSlotPtr = new SlotPointer(slotPos, nextSlot);
                } else if (target.kind === 'key') {
                  nextSlotPtr = new SlotPointer(keySlotPos, kvPair.keySlot);
                } else {
                  nextSlotPtr = new SlotPointer(valueSlotPos, kvPair.valueSlot);
                }
                return new HashMapGetResult(nextSlotPtr, false);
              }
            } else if (this.header.tag === Tag.ARRAY_LIST) {
              throw new ExpectedTxStartException();
            }
          }

          const keySlotPos = ptr + this.header.hashSize;
          const valueSlotPos = keySlotPos + Slot.LENGTH;
          let nextSlotPtr: SlotPointer;
          if (target.kind === 'kv_pair') {
            nextSlotPtr = new SlotPointer(slotPos, slot);
          } else if (target.kind === 'key') {
            nextSlotPtr = new SlotPointer(keySlotPos, kvPair.keySlot);
          } else {
            nextSlotPtr = new SlotPointer(valueSlotPos, kvPair.valueSlot);
          }
          return new HashMapGetResult(nextSlotPtr, false);
        } else {
          switch (writeMode) {
            case WriteMode.READ_ONLY:
              throw new KeyNotFoundException();
            case WriteMode.READ_WRITE: {
              if (keyOffset + 1 >= (this.header.hashSize * 8) / BIT_COUNT) {
                throw new KeyOffsetExceededException();
              }
              const nextI = Number(bigIntShiftRight(kvPair.hash, (keyOffset + 1) * BIT_COUNT) & MASK);
              const nextIndexPos = this.core.length();
              this.core.seek(nextIndexPos);
              writer.write(new Uint8Array(INDEX_BLOCK_SIZE));
              this.core.seek(nextIndexPos + Slot.LENGTH * nextI);
              writer.write(slot.toBytes());
              const res = this.readMapSlot(nextIndexPos, keyHash, keyOffset + 1, writeMode, isTopLevel, target);
              this.core.seek(slotPos);
              writer.write(new Slot(nextIndexPos, Tag.INDEX).toBytes());
              return res;
            }
            default:
              throw new UnreachableException();
          }
        }
      }
      default:
        throw new UnexpectedTagException();
    }
  }

  removeMapSlot(
    indexPos: number,
    keyHash: Uint8Array,
    keyOffset: number,
    isTopLevel: boolean
  ): Slot {
    if (keyOffset > (this.header.hashSize * 8) / BIT_COUNT) {
      throw new KeyOffsetExceededException();
    }

    const reader = this.core.reader();
    const writer = this.core.writer();

    const slotBlock: Slot[] = new Array(SLOT_COUNT);
    this.core.seek(indexPos);
    const indexBlock = new Uint8Array(INDEX_BLOCK_SIZE);
    reader.readFully(indexBlock);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slotBytes = indexBlock.slice(i * Slot.LENGTH, (i + 1) * Slot.LENGTH);
      slotBlock[i] = Slot.fromBytes(slotBytes);
    }

    const i = Number(bigIntShiftRight(keyHash, keyOffset * BIT_COUNT) & MASK);
    const slotPos = indexPos + Slot.LENGTH * i;
    const slot = slotBlock[i];

    let nextSlot: Slot;
    switch (slot.tag) {
      case Tag.NONE:
        throw new KeyNotFoundException();
      case Tag.INDEX:
        nextSlot = this.removeMapSlot(Number(slot.value), keyHash, keyOffset + 1, isTopLevel);
        break;
      case Tag.KV_PAIR: {
        this.core.seek(Number(slot.value));
        const kvPairBytes = new Uint8Array(KeyValuePair.length(this.header.hashSize));
        reader.readFully(kvPairBytes);
        const kvPair = KeyValuePair.fromBytes(kvPairBytes, this.header.hashSize);
        if (arraysEqual(kvPair.hash, keyHash)) {
          nextSlot = new Slot();
        } else {
          throw new KeyNotFoundException();
        }
        break;
      }
      default:
        throw new UnexpectedTagException();
    }

    if (keyOffset === 0) {
      this.core.seek(slotPos);
      writer.write(nextSlot.toBytes());
      return new Slot(indexPos, Tag.INDEX);
    }

    let slotToReturnMaybe: Slot | null = new Slot();
    slotBlock[i] = nextSlot;
    for (const blockSlot of slotBlock) {
      if (blockSlot.tag === Tag.NONE) continue;

      if (slotToReturnMaybe !== null) {
        if (slotToReturnMaybe.tag !== Tag.NONE) {
          slotToReturnMaybe = null;
          break;
        }
      }

      slotToReturnMaybe = blockSlot;
    }

    if (slotToReturnMaybe !== null) {
      switch (slotToReturnMaybe.tag) {
        case Tag.NONE:
        case Tag.KV_PAIR:
          return slotToReturnMaybe;
        default:
          break;
      }
    }

    if (!isTopLevel) {
      if (this.txStart !== null) {
        if (indexPos < this.txStart) {
          const nextIndexPos = this.core.length();
          this.core.seek(nextIndexPos);
          writer.write(indexBlock);
          const nextSlotPos = nextIndexPos + Slot.LENGTH * i;
          this.core.seek(nextSlotPos);
          writer.write(nextSlot.toBytes());
          return new Slot(nextIndexPos, Tag.INDEX);
        }
      } else if (this.header.tag === Tag.ARRAY_LIST) {
        throw new ExpectedTxStartException();
      }
    }

    this.core.seek(slotPos);
    writer.write(nextSlot.toBytes());
    return new Slot(indexPos, Tag.INDEX);
  }

  // ArrayList methods
  readArrayListSlotAppend(
    header: ArrayListHeader,
    writeMode: WriteMode,
    isTopLevel: boolean
  ): ArrayListAppendResult {
    const writer = this.core.writer();

    let indexPos = header.ptr;
    const key = header.size;

    const prevShift = key < SLOT_COUNT ? 0 : Math.floor(Math.log(key - 1) / Math.log(SLOT_COUNT));
    const nextShift = key < SLOT_COUNT ? 0 : Math.floor(Math.log(key) / Math.log(SLOT_COUNT));

    if (prevShift !== nextShift) {
      const nextIndexPos = this.core.length();
      this.core.seek(nextIndexPos);
      writer.write(new Uint8Array(INDEX_BLOCK_SIZE));
      this.core.seek(nextIndexPos);
      writer.write(new Slot(indexPos, Tag.INDEX).toBytes());
      indexPos = nextIndexPos;
    }

    const slotPtr = this.readArrayListSlot(indexPos, key, nextShift, writeMode, isTopLevel);
    return new ArrayListAppendResult(new ArrayListHeader(indexPos, header.size + 1), slotPtr);
  }

  readArrayListSlot(
    indexPos: number,
    key: number,
    shift: number,
    writeMode: WriteMode,
    isTopLevel: boolean
  ): SlotPointer {
    if (shift >= MAX_BRANCH_LENGTH) throw new MaxShiftExceededException();

    const reader = this.core.reader();

    const i = (key >>> (shift * BIT_COUNT)) & (SLOT_COUNT - 1);
    const slotPos = indexPos + Slot.LENGTH * i;
    this.core.seek(slotPos);
    const slotBytes = new Uint8Array(Slot.LENGTH);
    reader.readFully(slotBytes);
    const slot = Slot.fromBytes(slotBytes);

    if (shift === 0) {
      return new SlotPointer(slotPos, slot);
    }

    const ptr = Number(slot.value);

    switch (slot.tag) {
      case Tag.NONE: {
        switch (writeMode) {
          case WriteMode.READ_ONLY:
            throw new KeyNotFoundException();
          case WriteMode.READ_WRITE: {
            const writer = this.core.writer();
            const nextIndexPos = this.core.length();
            this.core.seek(nextIndexPos);
            writer.write(new Uint8Array(INDEX_BLOCK_SIZE));

            if (isTopLevel) {
              const fileSize = this.core.length();
              this.core.seek(Header.LENGTH + ArrayListHeader.LENGTH);
              writer.writeLong(fileSize);
            }

            this.core.seek(slotPos);
            writer.write(new Slot(nextIndexPos, Tag.INDEX).toBytes());
            return this.readArrayListSlot(nextIndexPos, key, shift - 1, writeMode, isTopLevel);
          }
          default:
            throw new UnreachableException();
        }
      }
      case Tag.INDEX: {
        let nextPtr = ptr;
        if (writeMode === WriteMode.READ_WRITE && !isTopLevel) {
          if (this.txStart !== null) {
            if (nextPtr < this.txStart) {
              this.core.seek(ptr);
              const indexBlock = new Uint8Array(INDEX_BLOCK_SIZE);
              reader.readFully(indexBlock);

              const writer = this.core.writer();
              nextPtr = this.core.length();
              this.core.seek(nextPtr);
              writer.write(indexBlock);

              this.core.seek(slotPos);
              writer.write(new Slot(nextPtr, Tag.INDEX).toBytes());
            }
          } else if (this.header.tag === Tag.ARRAY_LIST) {
            throw new ExpectedTxStartException();
          }
        }
        return this.readArrayListSlot(nextPtr, key, shift - 1, writeMode, isTopLevel);
      }
      default:
        throw new UnexpectedTagException();
    }
  }

  readArrayListSlice(header: ArrayListHeader, size: number): ArrayListHeader {
    const reader = this.core.reader();

    if (size > header.size || size < 0) {
      throw new KeyNotFoundException();
    }

    const prevShift = header.size < SLOT_COUNT + 1 ? 0 : Math.floor(Math.log(header.size - 1) / Math.log(SLOT_COUNT));
    const nextShift = size < SLOT_COUNT + 1 ? 0 : Math.floor(Math.log(size - 1) / Math.log(SLOT_COUNT));

    if (prevShift === nextShift) {
      return new ArrayListHeader(header.ptr, size);
    } else {
      let shift = prevShift;
      let indexPos = header.ptr;
      while (shift > nextShift) {
        this.core.seek(indexPos);
        const slotBytes = new Uint8Array(Slot.LENGTH);
        reader.readFully(slotBytes);
        const slot = Slot.fromBytes(slotBytes);
        shift -= 1;
        indexPos = Number(slot.value);
      }
      return new ArrayListHeader(indexPos, size);
    }
  }

  // linked_array_list (backed by a count-augmented B-tree)

  readBTreeNode(ptr: number): BTreeNode {
    this.core.seek(ptr);
    const reader = this.core.reader();
    const headerBytes = new Uint8Array(BTREE_NODE_HEADER_SIZE);
    reader.readFully(headerBytes);
    const kindInt = headerBytes[0];
    if (kindInt > BTreeNodeKind.BRANCH) throw new InvalidBTreeNodeKindException();
    const kind = kindInt as BTreeNodeKind;
    const num = headerBytes[1];
    if (num > BTREE_SLOT_COUNT) throw new InvalidBTreeNodeException();
    const node = new BTreeNode(kind, num);
    switch (kind) {
      case BTreeNodeKind.LEAF: {
        const body = new Uint8Array(Slot.LENGTH * BTREE_SLOT_COUNT);
        reader.readFully(body);
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          node.values[i] = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
        }
        break;
      }
      case BTreeNodeKind.BRANCH: {
        const body = new Uint8Array((Slot.LENGTH + 8) * BTREE_SLOT_COUNT);
        reader.readFully(body);
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          node.children[i] = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
        }
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const countsOffset = Slot.LENGTH * BTREE_SLOT_COUNT;
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          node.counts[i] = Number(view.getBigInt64(countsOffset + i * 8, false));
        }
        break;
      }
    }
    return node;
  }

  // always writes the node as a block at ptr. b-tree mutations are persistent:
  // every node on the path from the root is rewritten, while untouched subtrees
  // are shared by pointer.
  writeBTreeNodeAt(node: BTreeNode, ptr: number): void {
    this.core.seek(ptr);
    const writer = this.core.writer();
    const bodySize = node.kind === BTreeNodeKind.LEAF ? BTREE_LEAF_BLOCK_SIZE : BTREE_BRANCH_BLOCK_SIZE;
    const buffer = new Uint8Array(bodySize);
    buffer[0] = node.kind;
    buffer[1] = node.num;
    let off = BTREE_NODE_HEADER_SIZE;
    switch (node.kind) {
      case BTreeNodeKind.LEAF:
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          buffer.set(node.values[i].toBytes(), off);
          off += Slot.LENGTH;
        }
        break;
      case BTreeNodeKind.BRANCH: {
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          buffer.set(node.children[i].toBytes(), off);
          off += Slot.LENGTH;
        }
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          view.setBigInt64(off, BigInt(node.counts[i]), false);
          off += 8;
        }
        break;
      }
    }
    writer.write(buffer);
  }

  // appends the node as a fresh block and returns its position
  writeBTreeNode(node: BTreeNode): number {
    const ptr = this.core.length();
    this.writeBTreeNodeAt(node, ptr);
    return ptr;
  }

  // a node is safe to mutate in place when it was created in the current transaction
  // (offset >= txStart), since no committed moment and no pre-concat sharing can
  // reference it. concat advances txStart (an implicit freeze) precisely so its
  // shared subtrees fall below it here. for an ephemeral (non-array-list) top level
  // there is no transaction, so everything is mutable in place until a concat first
  // sets txStart.
  btreeReusable(ptr: number): boolean {
    if (this.txStart !== null) return ptr >= this.txStart;
    return this.header.tag !== Tag.ARRAY_LIST;
  }

  // write a new version of a node, reusing oldPtr's position in place if that node
  // belongs to this transaction, otherwise appending a copy
  btreeWriteNode(node: BTreeNode, oldPtr: number): number {
    if (this.btreeReusable(oldPtr)) {
      this.writeBTreeNodeAt(node, oldPtr);
      return oldPtr;
    }
    return this.writeBTreeNode(node);
  }

  btreeNewRoot(): number {
    return this.writeBTreeNode(new BTreeNode(BTreeNodeKind.LEAF, 0));
  }

  // descend to the value slot at the given rank (0-based), returning a pointer to it
  // (its file position and current slot).
  readBTreeSlot(rootPtr: number, rank: number): SlotPointer {
    let nodePtr = rootPtr;
    let rem = rank;
    while (true) {
      const node = this.readBTreeNode(nodePtr);
      if (node.kind === BTreeNodeKind.LEAF) {
        const position = nodePtr + BTREE_NODE_HEADER_SIZE + rem * Slot.LENGTH;
        return new SlotPointer(position, node.values[rem]);
      } else {
        let i = 0;
        while (i + 1 < node.num && rem >= node.counts[i]) {
          rem -= node.counts[i];
          i++;
        }
        nodePtr = Number(node.children[i].value);
      }
    }
  }

  // insert a placeholder slot at `rank` within the subtree at nodePtr, writing new
  // nodes along the path. the caller fills in the value at the returned valuePosition.
  btreeInsert(nodePtr: number, rank: number): BTreeInsertResult {
    const node = this.readBTreeNode(nodePtr);
    switch (node.kind) {
      case BTreeNodeKind.LEAF: {
        // build the entries with a placeholder spliced in at `rank`. the placeholder
        // is a NONE slot marked full so that, if the caller never writes a value
        // (e.g. appendCursor), iteration still counts it as an element rather than
        // skipping it as padding.
        const r = rank;
        const vals: Slot[] = [];
        for (let k = 0; k < r; k++) vals.push(node.values[k]);
        vals.push(new Slot(0, Tag.NONE, true));
        for (let k = r; k < node.num; k++) vals.push(node.values[k]);
        const total = node.num + 1;

        if (total <= BTREE_SLOT_COUNT) {
          const leaf = new BTreeNode(BTreeNodeKind.LEAF, total);
          for (let k = 0; k < total; k++) leaf.values[k] = vals[k];
          const ptr = this.btreeWriteNode(leaf, nodePtr);
          return new BTreeInsertResult(ptr, total, ptr + BTREE_NODE_HEADER_SIZE + r * Slot.LENGTH, null);
        }

        // overflow: split into two leaves (reuse this node for the left half)
        const leftN = BTREE_SPLIT_COUNT;
        const rightN = total - leftN;
        const left = new BTreeNode(BTreeNodeKind.LEAF, leftN);
        for (let k = 0; k < leftN; k++) left.values[k] = vals[k];
        const right = new BTreeNode(BTreeNodeKind.LEAF, rightN);
        for (let k = 0; k < rightN; k++) right.values[k] = vals[leftN + k];
        const leftPtr = this.btreeWriteNode(left, nodePtr);
        const rightPtr = this.writeBTreeNode(right);
        const valuePosition = r < leftN
          ? leftPtr + BTREE_NODE_HEADER_SIZE + r * Slot.LENGTH
          : rightPtr + BTREE_NODE_HEADER_SIZE + (r - leftN) * Slot.LENGTH;
        return new BTreeInsertResult(leftPtr, leftN, valuePosition, new BTreeNodeRef(rightPtr, rightN));
      }
      case BTreeNodeKind.BRANCH: {
        // pick the child that contains `rank`
        let i = 0;
        let rem = rank;
        while (i + 1 < node.num && rem > node.counts[i]) {
          rem -= node.counts[i];
          i++;
        }
        const child = this.btreeInsert(Number(node.children[i].value), rem);

        // rebuild this branch with the (possibly split) child
        const children: Slot[] = [];
        const counts: number[] = [];
        for (let k = 0; k < node.num; k++) {
          children.push(node.children[k]);
          counts.push(node.counts[k]);
        }
        children[i] = new Slot(child.nodePtr, Tag.INDEX);
        counts[i] = child.count;
        let total = node.num;
        if (child.split !== null) {
          children.splice(i + 1, 0, new Slot(child.split.nodePtr, Tag.INDEX));
          counts.splice(i + 1, 0, child.split.count);
          total = node.num + 1;
        }

        if (total <= BTREE_SLOT_COUNT) {
          const branch = new BTreeNode(BTreeNodeKind.BRANCH, total);
          for (let k = 0; k < total; k++) {
            branch.children[k] = children[k];
            branch.counts[k] = counts[k];
          }
          const ptr = this.btreeWriteNode(branch, nodePtr);
          return new BTreeInsertResult(ptr, branch.subtreeCount(), child.valuePosition, null);
        }

        // overflow: split into two branches (reuse this node for the left half)
        const leftN = BTREE_SPLIT_COUNT;
        const rightN = total - leftN;
        const left = new BTreeNode(BTreeNodeKind.BRANCH, leftN);
        for (let k = 0; k < leftN; k++) {
          left.children[k] = children[k];
          left.counts[k] = counts[k];
        }
        const right = new BTreeNode(BTreeNodeKind.BRANCH, rightN);
        for (let k = 0; k < rightN; k++) {
          right.children[k] = children[leftN + k];
          right.counts[k] = counts[leftN + k];
        }
        const leftPtr = this.btreeWriteNode(left, nodePtr);
        const rightPtr = this.writeBTreeNode(right);
        return new BTreeInsertResult(
          leftPtr,
          left.subtreeCount(),
          child.valuePosition,
          new BTreeNodeRef(rightPtr, right.subtreeCount())
        );
      }
    }
    throw new UnreachableException();
  }

  // turn an insert result into a root pointer, growing the tree a level if the old
  // root split (shares the root-building logic with btreeMakeRoot)
  btreeGrowRoot(result: BTreeInsertResult): number {
    return this.btreeMakeRoot(new BTreeJoinResult(result.nodePtr, result.count, result.split));
  }

  // descend to the value slot at `rank` for writing, copy-on-writing only the nodes
  // that belong to a past transaction. the element count is unchanged, so when the
  // whole path is already this-transaction nothing is rewritten and the caller writes
  // straight into the existing leaf.
  btreeGetForWrite(nodePtr: number, rank: number): BTreeWriteSlot {
    const node = this.readBTreeNode(nodePtr);
    switch (node.kind) {
      case BTreeNodeKind.LEAF: {
        const newPtr = this.btreeReusable(nodePtr) ? nodePtr : this.writeBTreeNode(node);
        return new BTreeWriteSlot(newPtr, newPtr + BTREE_NODE_HEADER_SIZE + rank * Slot.LENGTH, node.values[rank]);
      }
      case BTreeNodeKind.BRANCH: {
        let i = 0;
        let rem = rank;
        while (i + 1 < node.num && rem >= node.counts[i]) {
          rem -= node.counts[i];
          i++;
        }
        const childPtr = Number(node.children[i].value);
        const child = this.btreeGetForWrite(childPtr, rem);
        // if the child stayed put, this branch is unchanged too
        if (child.nodePtr === childPtr) {
          return new BTreeWriteSlot(nodePtr, child.valuePosition, child.slot);
        }
        node.children[i] = new Slot(child.nodePtr, Tag.INDEX);
        const newPtr = this.btreeWriteNode(node, nodePtr);
        return new BTreeWriteSlot(newPtr, child.valuePosition, child.slot);
      }
    }
    throw new UnreachableException();
  }

  // join (concat): a true O(log n), structure-sharing concatenation of two trees where
  // every element of `a` precedes every element of `b`. unlike the rebuild helpers
  // above, untouched subtrees are shared by pointer, so concatenating a list with
  // itself stays cheap.

  // height of a tree = number of branch levels above the leaves
  btreeHeight(rootPtr: number): number {
    let ptr = rootPtr;
    let height = 0;
    while (true) {
      const node = this.readBTreeNode(ptr);
      if (node.kind === BTreeNodeKind.LEAF) return height;
      height++;
      ptr = Number(node.children[0].value);
    }
  }

  btreeMakeRoot(result: BTreeJoinResult): number {
    if (result.split !== null) {
      const root = new BTreeNode(BTreeNodeKind.BRANCH, 2);
      root.children[0] = new Slot(result.nodePtr, Tag.INDEX);
      root.children[1] = new Slot(result.split.nodePtr, Tag.INDEX);
      root.counts[0] = result.count;
      root.counts[1] = result.split.count;
      return this.writeBTreeNode(root);
    }
    return result.nodePtr;
  }

  // write `vals` as one leaf, or split into two balanced leaves if it exceeds the node
  // capacity
  btreeAssembleLeaf(vals: Slot[], total: number): BTreeJoinResult {
    if (total <= BTREE_SLOT_COUNT) {
      const leaf = new BTreeNode(BTreeNodeKind.LEAF, total);
      for (let k = 0; k < total; k++) leaf.values[k] = vals[k];
      return new BTreeJoinResult(this.writeBTreeNode(leaf), total, null);
    }
    const leftN = Math.floor(total / 2);
    const left = new BTreeNode(BTreeNodeKind.LEAF, leftN);
    for (let k = 0; k < leftN; k++) left.values[k] = vals[k];
    const right = new BTreeNode(BTreeNodeKind.LEAF, total - leftN);
    for (let k = 0; k < total - leftN; k++) right.values[k] = vals[leftN + k];
    return new BTreeJoinResult(this.writeBTreeNode(left), leftN, new BTreeNodeRef(this.writeBTreeNode(right), total - leftN));
  }

  // write `children`/`counts` as one branch, or split into two balanced branches
  btreeAssembleBranch(children: Slot[], counts: number[], total: number): BTreeJoinResult {
    if (total <= BTREE_SLOT_COUNT) {
      const branch = new BTreeNode(BTreeNodeKind.BRANCH, total);
      for (let k = 0; k < total; k++) {
        branch.children[k] = children[k];
        branch.counts[k] = counts[k];
      }
      return new BTreeJoinResult(this.writeBTreeNode(branch), branch.subtreeCount(), null);
    }
    const leftN = Math.floor(total / 2);
    const left = new BTreeNode(BTreeNodeKind.BRANCH, leftN);
    for (let k = 0; k < leftN; k++) {
      left.children[k] = children[k];
      left.counts[k] = counts[k];
    }
    const right = new BTreeNode(BTreeNodeKind.BRANCH, total - leftN);
    for (let k = 0; k < total - leftN; k++) {
      right.children[k] = children[leftN + k];
      right.counts[k] = counts[leftN + k];
    }
    return new BTreeJoinResult(
      this.writeBTreeNode(left),
      left.subtreeCount(),
      new BTreeNodeRef(this.writeBTreeNode(right), right.subtreeCount())
    );
  }

  // merge two nodes of equal height (a precedes b) into one or two nodes
  btreeMergeNodes(a: BTreeNode, b: BTreeNode): BTreeJoinResult {
    switch (a.kind) {
      case BTreeNodeKind.LEAF: {
        const vals: Slot[] = [];
        for (let k = 0; k < a.num; k++) vals.push(a.values[k]);
        for (let k = 0; k < b.num; k++) vals.push(b.values[k]);
        return this.btreeAssembleLeaf(vals, a.num + b.num);
      }
      case BTreeNodeKind.BRANCH: {
        const children: Slot[] = [];
        const counts: number[] = [];
        for (let k = 0; k < a.num; k++) {
          children.push(a.children[k]);
          counts.push(a.counts[k]);
        }
        for (let k = 0; k < b.num; k++) {
          children.push(b.children[k]);
          counts.push(b.counts[k]);
        }
        return this.btreeAssembleBranch(children, counts, a.num + b.num);
      }
    }
    throw new UnreachableException();
  }

  // join b (shorter) into the rightmost spine of a (taller), at height hb
  btreeJoinRight(aPtr: number, ha: number, bPtr: number, hb: number): BTreeJoinResult {
    const a = this.readBTreeNode(aPtr);
    const last = a.num - 1;
    const sub = ha - 1 === hb
      ? this.btreeMergeNodes(this.readBTreeNode(Number(a.children[last].value)), this.readBTreeNode(bPtr))
      : this.btreeJoinRight(Number(a.children[last].value), ha - 1, bPtr, hb);

    const children: Slot[] = [];
    const counts: number[] = [];
    for (let k = 0; k < a.num; k++) {
      children.push(a.children[k]);
      counts.push(a.counts[k]);
    }
    children[last] = new Slot(sub.nodePtr, Tag.INDEX);
    counts[last] = sub.count;
    let total = a.num;
    if (sub.split !== null) {
      children[total] = new Slot(sub.split.nodePtr, Tag.INDEX);
      counts[total] = sub.split.count;
      total += 1;
    }
    return this.btreeAssembleBranch(children, counts, total);
  }

  // join a (shorter) into the leftmost spine of b (taller), at height ha
  btreeJoinLeft(aPtr: number, ha: number, bPtr: number, hb: number): BTreeJoinResult {
    const b = this.readBTreeNode(bPtr);
    const sub = hb - 1 === ha
      ? this.btreeMergeNodes(this.readBTreeNode(aPtr), this.readBTreeNode(Number(b.children[0].value)))
      : this.btreeJoinLeft(aPtr, ha, Number(b.children[0].value), hb - 1);

    const children: Slot[] = [];
    const counts: number[] = [];
    children[0] = new Slot(sub.nodePtr, Tag.INDEX);
    counts[0] = sub.count;
    let head = 1;
    if (sub.split !== null) {
      children[1] = new Slot(sub.split.nodePtr, Tag.INDEX);
      counts[1] = sub.split.count;
      head = 2;
    }
    for (let k = 0; k < b.num - 1; k++) {
      children[head + k] = b.children[1 + k];
      counts[head + k] = b.counts[1 + k];
    }
    return this.btreeAssembleBranch(children, counts, head + b.num - 1);
  }

  btreeJoin(rootA: number, rootB: number): number {
    const ha = this.btreeHeight(rootA);
    const hb = this.btreeHeight(rootB);
    let result: BTreeJoinResult;
    if (ha === hb) {
      result = this.btreeMergeNodes(this.readBTreeNode(rootA), this.readBTreeNode(rootB));
    } else if (ha > hb) {
      result = this.btreeJoinRight(rootA, ha, rootB, hb);
    } else {
      result = this.btreeJoinLeft(rootA, ha, rootB, hb);
    }
    return this.btreeMakeRoot(result);
  }

  // split (used by slice and remove): a true O(log n), structure-sharing split of a
  // tree into [0, rank) and [rank, size). partial nodes along the path are reassembled
  // with join, so the result trees stay balanced.

  // build a tree from a run of sibling children (already height-h-1 subtrees): empty ->
  // a new empty leaf, one -> that child unwrapped, many -> a branch
  btreeSubtree(children: Slot[], counts: number[], start: number, len: number): number {
    if (len === 0) return this.btreeNewRoot();
    if (len === 1) return Number(children[start].value);
    // len <= BTREE_SLOT_COUNT here, so this never splits
    const subChildren: Slot[] = [];
    const subCounts: number[] = [];
    for (let k = 0; k < len; k++) {
      subChildren.push(children[start + k]);
      subCounts.push(counts[start + k]);
    }
    return this.btreeAssembleBranch(subChildren, subCounts, len).nodePtr;
  }

  btreeSplit(rootPtr: number, rank: number): BTreeSplitResult {
    const node = this.readBTreeNode(rootPtr);
    switch (node.kind) {
      case BTreeNodeKind.LEAF: {
        const r = rank;
        const left = new BTreeNode(BTreeNodeKind.LEAF, r);
        for (let k = 0; k < r; k++) left.values[k] = node.values[k];
        const right = new BTreeNode(BTreeNodeKind.LEAF, node.num - r);
        for (let k = 0; k < node.num - r; k++) right.values[k] = node.values[r + k];
        return new BTreeSplitResult(this.writeBTreeNode(left), this.writeBTreeNode(right));
      }
      case BTreeNodeKind.BRANCH: {
        let i = 0;
        let rem = rank;
        while (i + 1 < node.num && rem > node.counts[i]) {
          rem -= node.counts[i];
          i++;
        }
        const child = this.btreeSplit(Number(node.children[i].value), rem);
        const leftSub = this.btreeSubtree(node.children, node.counts, 0, i);
        const rightSub = this.btreeSubtree(node.children, node.counts, i + 1, node.num - (i + 1));
        return new BTreeSplitResult(this.btreeJoin(leftSub, child.left), this.btreeJoin(child.right, rightSub));
      }
    }
    throw new UnreachableException();
  }
}

// compaction helpers

function remapSlot(
  sourceCore: Core,
  targetCore: Core,
  hashSize: number,
  offsetMap: Map<number, number>,
  slot: Slot
): Slot {
  switch (slot.tag) {
    case Tag.NONE:
    case Tag.UINT:
    case Tag.INT:
    case Tag.FLOAT:
    case Tag.SHORT_BYTES:
      return slot;
    case Tag.BYTES: {
      const mapped = offsetMap.get(Number(slot.value));
      if (mapped !== undefined) return new Slot(mapped, slot.tag, slot.full);
      const newOffset = remapBytes(sourceCore, targetCore, slot);
      offsetMap.set(Number(slot.value), newOffset);
      return new Slot(newOffset, slot.tag, slot.full);
    }
    case Tag.INDEX: {
      const mapped = offsetMap.get(Number(slot.value));
      if (mapped !== undefined) return new Slot(mapped, slot.tag, slot.full);
      const newOffset = remapIndex(sourceCore, targetCore, hashSize, offsetMap, slot);
      offsetMap.set(Number(slot.value), newOffset);
      return new Slot(newOffset, slot.tag, slot.full);
    }
    case Tag.ARRAY_LIST: {
      const mapped = offsetMap.get(Number(slot.value));
      if (mapped !== undefined) return new Slot(mapped, slot.tag, slot.full);
      const newOffset = remapArrayList(sourceCore, targetCore, hashSize, offsetMap, slot);
      offsetMap.set(Number(slot.value), newOffset);
      return new Slot(newOffset, slot.tag, slot.full);
    }
    case Tag.LINKED_ARRAY_LIST: {
      const mapped = offsetMap.get(Number(slot.value));
      if (mapped !== undefined) return new Slot(mapped, slot.tag, slot.full);
      const newOffset = remapBTree(sourceCore, targetCore, hashSize, offsetMap, slot);
      offsetMap.set(Number(slot.value), newOffset);
      return new Slot(newOffset, slot.tag, slot.full);
    }
    case Tag.HASH_MAP:
    case Tag.HASH_SET: {
      const mapped = offsetMap.get(Number(slot.value));
      if (mapped !== undefined) return new Slot(mapped, slot.tag, slot.full);
      const newOffset = remapHashMapOrSet(sourceCore, targetCore, hashSize, offsetMap, slot, false);
      offsetMap.set(Number(slot.value), newOffset);
      return new Slot(newOffset, slot.tag, slot.full);
    }
    case Tag.COUNTED_HASH_MAP:
    case Tag.COUNTED_HASH_SET: {
      const mapped = offsetMap.get(Number(slot.value));
      if (mapped !== undefined) return new Slot(mapped, slot.tag, slot.full);
      const newOffset = remapHashMapOrSet(sourceCore, targetCore, hashSize, offsetMap, slot, true);
      offsetMap.set(Number(slot.value), newOffset);
      return new Slot(newOffset, slot.tag, slot.full);
    }
    case Tag.KV_PAIR: {
      const mapped = offsetMap.get(Number(slot.value));
      if (mapped !== undefined) return new Slot(mapped, slot.tag, slot.full);
      const newOffset = remapKvPair(sourceCore, targetCore, hashSize, offsetMap, slot);
      offsetMap.set(Number(slot.value), newOffset);
      return new Slot(newOffset, slot.tag, slot.full);
    }
    default:
      throw new UnexpectedTagException();
  }
}

function remapBytes(sourceCore: Core, targetCore: Core, slot: Slot): number {
  sourceCore.seek(Number(slot.value));
  const sourceReader = sourceCore.reader();
  const length = sourceReader.readLong();

  // total size: 8-byte length + bytes + optional 2-byte format_tag
  const formatTagSize = slot.full ? 2 : 0;
  const totalPayload = length + formatTagSize;

  const newOffset = targetCore.length();
  targetCore.seek(newOffset);
  const targetWriter = targetCore.writer();
  targetWriter.writeLong(length);

  // copy bytes in chunks
  let remaining = totalPayload;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 4096);
    const buf = new Uint8Array(chunk);
    sourceReader.readFully(buf);
    targetWriter.write(buf);
    remaining -= chunk;
  }

  return newOffset;
}

function remapIndex(
  sourceCore: Core,
  targetCore: Core,
  hashSize: number,
  offsetMap: Map<number, number>,
  slot: Slot
): number {
  // read 144-byte block (16 slots)
  sourceCore.seek(Number(slot.value));
  const sourceReader = sourceCore.reader();
  const blockBytes = new Uint8Array(INDEX_BLOCK_SIZE);
  sourceReader.readFully(blockBytes);

  // remap each slot
  const remappedSlots: Slot[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slotBytes = blockBytes.slice(i * Slot.LENGTH, (i + 1) * Slot.LENGTH);
    const childSlot = Slot.fromBytes(slotBytes);
    remappedSlots.push(remapSlot(sourceCore, targetCore, hashSize, offsetMap, childSlot));
  }

  // write remapped block to target
  const newOffset = targetCore.length();
  targetCore.seek(newOffset);
  const targetWriter = targetCore.writer();
  for (const s of remappedSlots) {
    targetWriter.write(s.toBytes());
  }

  return newOffset;
}

function remapArrayList(
  sourceCore: Core,
  targetCore: Core,
  hashSize: number,
  offsetMap: Map<number, number>,
  slot: Slot
): number {
  // read ArrayListHeader (16 bytes)
  sourceCore.seek(Number(slot.value));
  const sourceReader = sourceCore.reader();
  const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
  sourceReader.readFully(headerBytes);
  const header = ArrayListHeader.fromBytes(headerBytes);

  // remap root index block pointer via remapSlot as an .index slot
  const indexSlot = new Slot(header.ptr, Tag.INDEX);
  const remappedIndex = remapSlot(sourceCore, targetCore, hashSize, offsetMap, indexSlot);

  // write new ArrayListHeader with remapped ptr
  const newOffset = targetCore.length();
  targetCore.seek(newOffset);
  const targetWriter = targetCore.writer();
  targetWriter.write(new ArrayListHeader(Number(remappedIndex.value), header.size).toBytes());

  return newOffset;
}

function remapBTree(
  sourceCore: Core,
  targetCore: Core,
  hashSize: number,
  offsetMap: Map<number, number>,
  slot: Slot
): number {
  sourceCore.seek(Number(slot.value));
  const sourceReader = sourceCore.reader();
  const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
  sourceReader.readFully(headerBytes);
  const header = BTreeHeader.fromBytes(headerBytes);

  const remappedRoot = remapBTreeNode(sourceCore, targetCore, hashSize, offsetMap, header.rootPtr);

  const newOffset = targetCore.length();
  targetCore.seek(newOffset);
  const targetWriter = targetCore.writer();
  targetWriter.write(new BTreeHeader(remappedRoot, header.size).toBytes());

  return newOffset;
}

function remapBTreeNode(
  sourceCore: Core,
  targetCore: Core,
  hashSize: number,
  offsetMap: Map<number, number>,
  nodeOffset: number
): number {
  // dedup check (subtrees are shared by pointer)
  const mapped = offsetMap.get(nodeOffset);
  if (mapped !== undefined) return mapped;

  sourceCore.seek(nodeOffset);
  const sourceReader = sourceCore.reader();
  const nodeHeader = new Uint8Array(BTREE_NODE_HEADER_SIZE);
  sourceReader.readFully(nodeHeader);
  const kindInt = nodeHeader[0];
  if (kindInt > BTreeNodeKind.BRANCH) throw new InvalidBTreeNodeKindException();
  const kind = kindInt as BTreeNodeKind;
  const num = nodeHeader[1];

  switch (kind) {
    case BTreeNodeKind.LEAF: {
      const body = new Uint8Array(Slot.LENGTH * BTREE_SLOT_COUNT);
      sourceReader.readFully(body);

      const slots: Slot[] = [];
      for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
        const valueSlot = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
        slots.push(remapSlot(sourceCore, targetCore, hashSize, offsetMap, valueSlot));
      }

      const newOffset = targetCore.length();
      targetCore.seek(newOffset);
      const targetWriter = targetCore.writer();
      targetWriter.write(new Uint8Array([kindInt, num]));
      for (const s of slots) targetWriter.write(s.toBytes());

      offsetMap.set(nodeOffset, newOffset);
      return newOffset;
    }
    case BTreeNodeKind.BRANCH: {
      const body = new Uint8Array((Slot.LENGTH + 8) * BTREE_SLOT_COUNT);
      sourceReader.readFully(body);
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

      const children: Slot[] = [];
      for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
        const child = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
        if (child.tag === Tag.INDEX) {
          const remappedPtr = remapBTreeNode(sourceCore, targetCore, hashSize, offsetMap, Number(child.value));
          children.push(new Slot(remappedPtr, Tag.INDEX, child.full));
        } else {
          children.push(child);
        }
      }
      const countsOffset = Slot.LENGTH * BTREE_SLOT_COUNT;
      const counts: number[] = [];
      for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
        counts.push(Number(view.getBigInt64(countsOffset + i * 8, false)));
      }

      const newOffset = targetCore.length();
      targetCore.seek(newOffset);
      const targetWriter = targetCore.writer();
      targetWriter.write(new Uint8Array([kindInt, num]));
      for (const s of children) targetWriter.write(s.toBytes());
      for (const c of counts) targetWriter.writeLong(c);

      offsetMap.set(nodeOffset, newOffset);
      return newOffset;
    }
  }
  throw new UnreachableException();
}

function remapHashMapOrSet(
  sourceCore: Core,
  targetCore: Core,
  hashSize: number,
  offsetMap: Map<number, number>,
  slot: Slot,
  counted: boolean
): number {
  sourceCore.seek(Number(slot.value));
  const sourceReader = sourceCore.reader();

  let countValue = -1;
  if (counted) {
    countValue = sourceReader.readLong();
  }

  // read 144-byte root index block
  const blockBytes = new Uint8Array(INDEX_BLOCK_SIZE);
  sourceReader.readFully(blockBytes);

  // remap each child slot in the block
  const remappedSlots: Slot[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slotBytes = blockBytes.slice(i * Slot.LENGTH, (i + 1) * Slot.LENGTH);
    const childSlot = Slot.fromBytes(slotBytes);
    remappedSlots.push(remapSlot(sourceCore, targetCore, hashSize, offsetMap, childSlot));
  }

  // write [optional count][remapped block] contiguously to target
  const newOffset = targetCore.length();
  targetCore.seek(newOffset);
  const targetWriter = targetCore.writer();
  if (counted) {
    targetWriter.writeLong(countValue);
  }
  for (const s of remappedSlots) {
    targetWriter.write(s.toBytes());
  }

  return newOffset;
}

function remapKvPair(
  sourceCore: Core,
  targetCore: Core,
  hashSize: number,
  offsetMap: Map<number, number>,
  slot: Slot
): number {
  // read KeyValuePair
  sourceCore.seek(Number(slot.value));
  const sourceReader = sourceCore.reader();
  const kvPairBytes = new Uint8Array(KeyValuePair.length(hashSize));
  sourceReader.readFully(kvPairBytes);
  const kvPair = KeyValuePair.fromBytes(kvPairBytes, hashSize);

  // remap key_slot and value_slot
  const remappedKey = remapSlot(sourceCore, targetCore, hashSize, offsetMap, kvPair.keySlot);
  const remappedValue = remapSlot(sourceCore, targetCore, hashSize, offsetMap, kvPair.valueSlot);

  // write remapped KV pair (hash stays unchanged)
  const newOffset = targetCore.length();
  targetCore.seek(newOffset);
  const targetWriter = targetCore.writer();
  targetWriter.write(new KeyValuePair(remappedValue, remappedKey, kvPair.hash).toBytes());

  return newOffset;
}

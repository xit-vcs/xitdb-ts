import type { Core, DataReader, DataWriter } from './core.js';
import type { OffsetMap } from './offset-map.js';
import { Hasher } from './hasher.js';
import { crc64 } from './crc64.js';
import { Tag } from './tag.js';
import { Slot } from './slot.js';
import { SlotPointer } from './slot-pointer.js';
import {
  InvalidDatabaseException,
  TruncatedDatabaseException,
  InvalidVersionException,
  InvalidHashSizeException,
  KeyNotFoundException,
  WriteNotAllowedException,
  UnexpectedTagException,
  CursorNotWriteableException,
  ExpectedTxStartException,
  KeyOffsetExceededException,
  PathPartMustBeAtEndException,
  ExpectedUnsignedLongException,
  NoAvailableSlotsException,
  MustSetNewSlotsToFullException,
  EmptySlotException,
  ExpectedRootNodeException,
  UnreachableException,
  MaxShiftExceededException,
  InvalidBTreeNodeException,
  InvalidBTreeNodeKindException,
  InvalidRangeException,
  EndOfStreamException,
  TargetNotEmptyException,
} from './exceptions.js';
import { Bytes, Float, Int, Uint, type WriteableData } from './writeable-data.js';
import { WriteCursor } from './write-cursor.js';

export const VERSION = 1;
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
// sorted_map / sorted_set node block: [kind: u8][num: u8] then, for a leaf,
// BTREE_SLOT_COUNT .sorted_kv_pair slots;
// for a branch, BTREE_SLOT_COUNT child slots, then BTREE_SLOT_COUNT separator slots,
// then BTREE_SLOT_COUNT u64 counts
export const SORTED_LEAF_BLOCK_SIZE = BTREE_NODE_HEADER_SIZE + Slot.LENGTH * BTREE_SLOT_COUNT;
export const SORTED_BRANCH_BLOCK_SIZE = BTREE_NODE_HEADER_SIZE + (Slot.LENGTH * 2 + 8) * BTREE_SLOT_COUNT;

export enum WriteMode {
  READ_ONLY,
  READ_WRITE,
}

// Header
export class Header {
  static readonly LENGTH = 20;

  constructor(
    // a random ID that never changes. it is part of every trailer's checksum,
    // so a replica can't be extended with bytes from a different file.
    public fileId: bigint,
    public hashId: number,
    public hashSize: number,
    // the file format version
    public version: number,
    public magicNumber: Uint8Array
  ) {}

  toBytes(): Uint8Array {
    const buffer = new ArrayBuffer(Header.LENGTH);
    const view = new DataView(buffer);
    const arr = new Uint8Array(buffer);
    arr.set(this.magicNumber, 0);
    // byte 3 is currently unused
    view.setInt16(4, this.version, false);
    view.setInt16(6, this.hashSize, false);
    view.setInt32(8, this.hashId, false);
    view.setBigUint64(12, this.fileId, false);
    return arr;
  }

  static read(core: Core): Header {
    const reader = core.reader();
    const bytes = new Uint8Array(Header.LENGTH);
    reader.readFully(bytes);
    const view = new DataView(bytes.buffer);
    const magicNumber = bytes.slice(0, 3);
    const version = view.getInt16(4, false);
    const hashSize = view.getInt16(6, false);
    const hashId = view.getInt32(8, false);
    const fileId = view.getBigUint64(12, false);
    return new Header(fileId, hashId, hashSize, version, magicNumber);
  }

  write(core: Core): void {
    const writer = core.writer();
    writer.write(this.toBytes());
  }

  validate(): void {
    if (!arraysEqual(this.magicNumber, MAGIC_NUMBER)) {
      throw new InvalidDatabaseException();
    }
    if (this.version !== VERSION) {
      throw new InvalidVersionException();
    }
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

// the database header is followed by the root header. the top-level data is a
// root slot of any type, and every write to it is a copy-on-write transaction
// that appends a trailer holding the new root slot. the root header only caches
// the latest trailer, so every other committed byte is immutable, and a replica
// stays in sync by copying the bytes it doesn't have.
export const ROOT_HEADER_START = Header.LENGTH;

// rewritten at every commit, as a cache of the latest trailer. the root slot
// comes first on disk.
export class RootHeader {
  static readonly LENGTH = Slot.LENGTH + 8;

  constructor(public fileSize: number, public root: Slot) {}

  toBytes(): Uint8Array {
    const buffer = new Uint8Array(RootHeader.LENGTH);
    buffer.set(this.root.toBytes(), 0);
    new DataView(buffer.buffer).setBigUint64(Slot.LENGTH, BigInt(this.fileSize), false);
    return buffer;
  }

  static fromBytes(bytes: Uint8Array): RootHeader {
    const root = Slot.fromBytes(bytes.subarray(0, Slot.LENGTH));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fileSize = Number(view.getBigUint64(Slot.LENGTH, false));
    return new RootHeader(fileSize, root);
  }
}

export const ROOT_HEADER_END = ROOT_HEADER_START + RootHeader.LENGTH;

// appended at the end of every transaction, so the committed bytes (up to the
// root header's `fileSize`) always end with one. the root slot comes first on
// disk.
export class RootTrailer {
  static readonly LENGTH = Slot.LENGTH + 16;

  constructor(
    public checksum: bigint,
    // random for every transaction except the first, so separately written
    // copies of a file can't end up with the same trailers, even when they
    // write data of the same size. that is how a replica notices it is being
    // sent bytes from a different history.
    public commitId: bigint,
    public root: Slot,
  ) {}

  static init(fileId: bigint, position: number, root: Slot, commitId: bigint): RootTrailer {
    return new RootTrailer(RootTrailer.computeChecksum(fileId, position, root.toBytes(), commitId), commitId, root);
  }

  // CRC-64/XZ of the file ID, the trailer's position, the root slot, and the
  // commit ID, all big endian. including the file ID and position means the
  // trailer can't be mistaken for one written elsewhere. 64 bits makes it safe
  // to find the last trailer by scanning a file whose root header can't be
  // trusted. the root slot is given as bytes, so a trailer can be checked
  // before its tag is validated.
  static computeChecksum(fileId: bigint, position: number, root: Uint8Array, commitId: bigint): bigint {
    const bytes = new Uint8Array(24 + Slot.LENGTH);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, fileId, false);
    view.setBigUint64(8, BigInt(position), false);
    bytes.set(root, 16);
    view.setBigUint64(16 + Slot.LENGTH, commitId, false);
    return crc64(bytes);
  }

  toBytes(): Uint8Array {
    const buffer = new Uint8Array(RootTrailer.LENGTH);
    buffer.set(this.root.toBytes(), 0);
    const view = new DataView(buffer.buffer);
    view.setBigUint64(Slot.LENGTH, this.commitId, false);
    view.setBigUint64(Slot.LENGTH + 8, this.checksum, false);
    return buffer;
  }
}

// what a replica sends its source, so the source knows which
// bytes to send back (see `Database.replicationStart`)
export interface ReplicaState {
  committedSize: number;
  // the checksum of the trailer that ends the committed bytes. it covers the
  // file ID and the commit's random ID, so it identifies both the file and the
  // history that led to the commit.
  checksum: bigint;
}

/** what `Database.openReplicated` returns: give it the bytes, then close it to commit them */
export interface ReplicaWriter {
  write(chunk: Uint8Array): void;
  close(): void;
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

// a KeyValuePair without the hash, which sorted maps don't need
export class SortedKeyValuePair {
  static readonly LENGTH = Slot.LENGTH * 2;

  constructor(public valueSlot: Slot, public keySlot: Slot) {}

  toBytes(): Uint8Array {
    const buffer = new Uint8Array(SortedKeyValuePair.LENGTH);
    buffer.set(this.keySlot.toBytes(), 0);
    buffer.set(this.valueSlot.toBytes(), Slot.LENGTH);
    return buffer;
  }

  static fromBytes(bytes: Uint8Array): SortedKeyValuePair {
    const keySlot = Slot.fromBytes(bytes.slice(0, Slot.LENGTH));
    const valueSlot = Slot.fromBytes(bytes.slice(Slot.LENGTH, Slot.LENGTH * 2));
    return new SortedKeyValuePair(valueSlot, keySlot);
  }
}

// where the key slot is in a .kv_pair or .sorted_kv_pair entry. the value slot follows it.
export function kvKeyOffset(tag: Tag, hashSize: number): number {
  return tag === Tag.KV_PAIR ? hashSize : 0;
}

// decodes a .kv_pair or .sorted_kv_pair entry. a .sorted_kv_pair has no hash, so it is 0.
export function decodeKvPair(reader: DataReader, tag: Tag, hashSize: number): KeyValuePair {
  switch (tag) {
    case Tag.KV_PAIR: {
      const bytes = new Uint8Array(KeyValuePair.length(hashSize));
      reader.readFully(bytes);
      return KeyValuePair.fromBytes(bytes, hashSize);
    }
    case Tag.SORTED_KV_PAIR: {
      const bytes = new Uint8Array(SortedKeyValuePair.LENGTH);
      reader.readFully(bytes);
      const pair = SortedKeyValuePair.fromBytes(bytes);
      return new KeyValuePair(pair.valueSlot, pair.keySlot, new Uint8Array(hashSize));
    }
    default:
      throw new UnexpectedTagException();
  }
}

// encodes a .kv_pair or .sorted_kv_pair entry. a .sorted_kv_pair leaves out the hash.
export function encodeKvPair(writer: DataWriter, tag: Tag, kvPair: KeyValuePair): void {
  switch (tag) {
    case Tag.KV_PAIR:
      writer.write(kvPair.toBytes());
      break;
    case Tag.SORTED_KV_PAIR:
      writer.write(new SortedKeyValuePair(kvPair.valueSlot, kvPair.keySlot).toBytes());
      break;
    default:
      throw new UnreachableException();
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

// sorted_map / sorted_set: a count-augmented B+tree keyed on arbitrary byte strings,
// ordered lexicographically. reuses the b-tree's capacity constants, persistence model
// (txStart reuse), and the BTreeHeader {rootPtr, size} header. a leaf holds
// .sorted_kv_pair entries in ascending key order; a branch holds child slots,
// separator slots (the smallest key in each child's subtree; separators[0] is an
// unused sentinel), and per-child subtree counts.
export class SortedNode {
  entries: Slot[] = new Array(BTREE_SLOT_COUNT); // leaf
  children: Slot[] = new Array(BTREE_SLOT_COUNT); // branch
  separators: Slot[] = new Array(BTREE_SLOT_COUNT); // branch
  counts: number[] = new Array(BTREE_SLOT_COUNT).fill(0); // branch

  constructor(public kind: BTreeNodeKind, public num: number) {
    for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
      this.entries[i] = new Slot();
      this.children[i] = new Slot();
      this.separators[i] = new Slot();
    }
  }

  subtreeCount(): number {
    if (this.kind === BTreeNodeKind.LEAF) return this.num;
    let total = 0;
    for (let i = 0; i < this.num; i++) total += this.counts[i];
    return total;
  }
}

// the new right sibling produced when a node splits
export class SortedSplit {
  constructor(public nodePtr: number, public count: number, public separator: Slot) {}
}

// insert/replace result: the entry whose value to write, whether a new entry was added
// (vs replacing), and the new right sibling if this node split
export class SortedInsertResult {
  constructor(
    public nodePtr: number,
    public count: number,
    public kvSlot: Slot,
    public added: boolean,
    public split: SortedSplit | null
  ) {}
}

// remove result threaded back up the descent: the rewritten node and whether the key
// was found. separators are stable lower-bound boundaries (not exact mins), so
// deletions never refresh them; an emptied leaf is left in place.
export class SortedRemoveResult {
  constructor(public nodePtr: number, public found: boolean) {}
}

export class SortedSlot {
  constructor(public slot: Slot, public position: number) {}
}

export class SortedEntry {
  constructor(public kvSlot: Slot, public keySlot: Slot) {}
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
  | SortedMapInit
  | SortedMapGet
  | SortedMapGetIndex
  | SortedMapRemove
  | WriteData
  | Context;

export interface PathPartBase {
  readSlotPointer(
    db: Database,
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

// SortedMapGetTarget types (the key is byte string, not a hash)
export type SortedMapGetTarget = SortedMapGetKVPair | SortedMapGetKey | SortedMapGetValue;

export class SortedMapGetKVPair {
  readonly kind = 'kv_pair';
  constructor(public key: Uint8Array) {}
}

export class SortedMapGetKey {
  readonly kind = 'key';
  constructor(public key: Uint8Array) {}
}

export class SortedMapGetValue {
  readonly kind = 'value';
  constructor(public key: Uint8Array) {}
}

// ContextFunction type
export type ContextFunction = (cursor: any) => void;

// PathPart implementations
export class ArrayListInit implements PathPartBase {
  readonly kind = 'ArrayListInit';

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();

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

        // copy it to the end unless it was made in this transaction
        if (db.isOld(arrayListStart)) {
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
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    switch (slotPtr.slot.tag) {
      case Tag.NONE:
        throw new KeyNotFoundException();
      case Tag.ARRAY_LIST:
        break;
      default:
        throw new UnexpectedTagException();
    }

    if (writeMode === WriteMode.READ_WRITE) slotPtr = db.copyCollectionIfFrozen(slotPtr, new ArrayListInit());
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
    const finalSlotPtr = db.readArrayListSlot(header.ptr, key, shift, writeMode);

    return db.readSlotPointer(writeMode, path, pathI + 1, finalSlotPtr);
  }
}

export class ArrayListAppend implements PathPartBase {
  readonly kind = 'ArrayListAppend';

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();

    if (slotPtr.slot.tag !== Tag.ARRAY_LIST) throw new UnexpectedTagException();

    const reader = db.core.reader();
    slotPtr = db.copyCollectionIfFrozen(slotPtr, new ArrayListInit());
    const nextArrayListStart = Number(slotPtr.slot.value);

    db.core.seek(nextArrayListStart);
    const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const origHeader = ArrayListHeader.fromBytes(headerBytes);

    const appendResult = db.readArrayListSlotAppend(origHeader, writeMode);
    // update the header before callbacks can freeze it
    const writer = db.core.writer();
    db.core.seek(nextArrayListStart);
    writer.write(appendResult.header.toBytes());
    // the appended slot is the transaction's root slot when this is the
    // top-level list (the list held by the transaction's copy of the root)
    if (db.transaction !== null && slotPtr.position === db.transaction.scratchPosition) {
      db.transaction.rootPosition = appendResult.slotPtr.position;
    }
    return db.readSlotPointer(writeMode, path, pathI + 1, appendResult.slotPtr);
  }
}

export class ArrayListSlice implements PathPartBase {
  readonly kind = 'ArrayListSlice';
  constructor(public size: number) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.ARRAY_LIST) throw new UnexpectedTagException();

    const reader = db.core.reader();
    slotPtr = db.copyCollectionIfFrozen(slotPtr, new ArrayListInit());
    const nextArrayListStart = Number(slotPtr.slot.value);

    db.core.seek(nextArrayListStart);
    const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const origHeader = ArrayListHeader.fromBytes(headerBytes);

    const sliceHeader = db.readArrayListSlice(origHeader, this.size);
    // update the header before callbacks can freeze it
    const writer = db.core.writer();
    db.core.seek(nextArrayListStart);
    writer.write(sliceHeader.toBytes());
    return db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);
  }
}

export class LinkedArrayListInit implements PathPartBase {
  readonly kind = 'LinkedArrayListInit';

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
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
        if (db.isOld(headerPtr)) {
          const reader = db.core.reader();
          db.core.seek(headerPtr);
          const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
          reader.readFully(headerBytes);
          headerPtr = db.core.length();
          db.core.seek(headerPtr);
          writer.write(headerBytes);
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

    if (writeMode === WriteMode.READ_WRITE) slotPtr = db.copyCollectionIfFrozen(slotPtr, new LinkedArrayListInit());
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
      // update the header before callbacks can freeze it
      if (writeSlot.nodePtr !== header.rootPtr) {
        const writer = db.core.writer();
        db.core.seek(headerPtr);
        writer.write(new BTreeHeader(writeSlot.nodePtr, header.size).toBytes());
      }
      return db.readSlotPointer(writeMode, path, pathI + 1, new SlotPointer(writeSlot.valuePosition, writeSlot.slot));
    }
  }
}

export class LinkedArrayListAppend implements PathPartBase {
  readonly kind = 'LinkedArrayListAppend';

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    slotPtr = db.copyCollectionIfFrozen(slotPtr, new LinkedArrayListInit());
    const headerPtr = Number(slotPtr.slot.value);
    const reader = db.core.reader();
    db.core.seek(headerPtr);
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);

    const result = db.btreeInsert(header.rootPtr, header.size);
    const newRootPtr = db.btreeGrowRoot(result);

    // update the header before filling in the value, so that a failure in the
    // rest of the path leaves the tree and header consistent
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, header.size + 1).toBytes());

    // fill in the value via the rest of the path
    return db.readSlotPointer(
      writeMode,
      path,
      pathI + 1,
      new SlotPointer(result.valuePosition, new Slot())
    );
  }
}

export class LinkedArrayListSlice implements PathPartBase {
  readonly kind = 'LinkedArrayListSlice';
  constructor(public offset: number, public size: number) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    slotPtr = db.copyCollectionIfFrozen(slotPtr, new LinkedArrayListInit());
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

    // update the header before recursing into the rest of the path, so that a
    // failure there leaves the tree and header consistent
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, this.size).toBytes());

    return db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);
  }
}

export class LinkedArrayListConcat implements PathPartBase {
  readonly kind = 'LinkedArrayListConcat';
  constructor(public list: Slot) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();
    if (this.list.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    slotPtr = db.copyCollectionIfFrozen(slotPtr, new LinkedArrayListInit());
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

    // update the header before recursing into the rest of the path, so that a
    // failure there leaves the tree and header consistent
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, headerA.size + headerB.size).toBytes());

    return db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);
  }
}

export class LinkedArrayListInsert implements PathPartBase {
  readonly kind = 'LinkedArrayListInsert';
  constructor(public index: number) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    slotPtr = db.copyCollectionIfFrozen(slotPtr, new LinkedArrayListInit());
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

    // update the header before filling in the value, so that a failure in the
    // rest of the path leaves the tree and header consistent
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, header.size + 1).toBytes());

    return db.readSlotPointer(
      writeMode,
      path,
      pathI + 1,
      new SlotPointer(result.valuePosition, new Slot())
    );
  }
}

export class LinkedArrayListRemove implements PathPartBase {
  readonly kind = 'LinkedArrayListRemove';
  constructor(public index: number) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.slot.tag !== Tag.LINKED_ARRAY_LIST) throw new UnexpectedTagException();

    slotPtr = db.copyCollectionIfFrozen(slotPtr, new LinkedArrayListInit());
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

    // update the header before recursing into the rest of the path, so that a
    // failure there leaves the tree and header consistent
    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(newRootPtr, header.size - 1).toBytes());

    return db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);
  }
}

export class HashMapInit implements PathPartBase {
  readonly kind = 'HashMapInit';
  constructor(public counted: boolean = false, public set: boolean = false) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();

    const tag = this.counted
      ? (this.set ? Tag.COUNTED_HASH_SET : Tag.COUNTED_HASH_MAP)
      : (this.set ? Tag.HASH_SET : Tag.HASH_MAP);

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

        // copy it to the end unless it was made in this transaction
        if (db.isOld(mapStart)) {
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

    if (writeMode === WriteMode.READ_WRITE) slotPtr = db.copyCollectionIfFrozen(slotPtr, new HashMapInit(counted, slotPtr.slot.tag === Tag.HASH_SET || slotPtr.slot.tag === Tag.COUNTED_HASH_SET));
    const indexPos = counted ? Number(slotPtr.slot.value) + 8 : Number(slotPtr.slot.value);
    const hash = db.checkHash(this.target);
    const res = db.readMapSlot(indexPos, hash, 0, writeMode, this.target);

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

    slotPtr = db.copyCollectionIfFrozen(slotPtr, new HashMapInit(counted, slotPtr.slot.tag === Tag.HASH_SET || slotPtr.slot.tag === Tag.COUNTED_HASH_SET));
    const indexPos = counted ? Number(slotPtr.slot.value) + 8 : Number(slotPtr.slot.value);
    const hash = db.checkHashBytes(this.hash);

    let keyFound = true;
    try {
      db.removeMapSlot(indexPos, hash, 0);
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

export class SortedMapInit implements PathPartBase {
  readonly kind = 'SortedMapInit';
  constructor(public set: boolean = false) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (slotPtr.position === null) throw new CursorNotWriteableException();
    const position = slotPtr.position;
    const tag = this.set ? Tag.SORTED_SET : Tag.SORTED_MAP;
    const writer = db.core.writer();
    switch (slotPtr.slot.tag) {
      case Tag.NONE: {
        const rootPtr = db.writeSortedNode(new SortedNode(BTreeNodeKind.LEAF, 0));
        const headerPtr = db.core.length();
        db.core.seek(headerPtr);
        writer.write(new BTreeHeader(rootPtr, 0).toBytes());
        const nextSlotPtr = new SlotPointer(position, new Slot(headerPtr, tag));
        db.core.seek(position);
        writer.write(nextSlotPtr.slot.toBytes());
        return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
      }
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET: {
        if (slotPtr.slot.tag !== tag) throw new UnexpectedTagException();
        let headerPtr = Number(slotPtr.slot.value);
        // copy the header into this transaction unless it was made in it
        if (db.isOld(headerPtr)) {
          const reader = db.core.reader();
          db.core.seek(headerPtr);
          const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
          reader.readFully(headerBytes);
          headerPtr = db.core.length();
          db.core.seek(headerPtr);
          writer.write(headerBytes);
        }
        const nextSlotPtr = new SlotPointer(position, new Slot(headerPtr, tag));
        db.core.seek(position);
        writer.write(nextSlotPtr.slot.toBytes());
        return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
      }
      default:
        throw new UnexpectedTagException();
    }
  }
}

export class SortedMapGet implements PathPartBase {
  readonly kind = 'SortedMapGet';
  constructor(public target: SortedMapGetTarget) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    switch (slotPtr.slot.tag) {
      case Tag.NONE:
        throw new KeyNotFoundException();
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET:
        break;
      default:
        throw new UnexpectedTagException();
    }

    const key = this.target.key;

    if (writeMode === WriteMode.READ_WRITE) slotPtr = db.copyCollectionIfFrozen(slotPtr, new SortedMapInit(slotPtr.slot.tag === Tag.SORTED_SET));
    const headerPtr = Number(slotPtr.slot.value);
    const reader = db.core.reader();
    db.core.seek(headerPtr);
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);

    if (writeMode === WriteMode.READ_ONLY) {
      const found = db.sortedGet(header.rootPtr, key);
      if (found === null) throw new KeyNotFoundException();
      const targetSlot = db.sortedTargetSlot(found.slot, this.target);
      return db.readSlotPointer(writeMode, path, pathI + 1, targetSlot);
    } else {
      const result = db.sortedPut(header.rootPtr, key);
      const newRootPtr = db.sortedGrowRoot(result);

      // update the header before filling in the value, so that a failure in the
      // rest of the path leaves the tree and header consistent (the entry exists
      // with an empty value) rather than inserted-but-uncounted
      const writer = db.core.writer();
      db.core.seek(headerPtr);
      writer.write(new BTreeHeader(newRootPtr, header.size + (result.added ? 1 : 0)).toBytes());

      const targetSlot = db.sortedTargetSlot(result.kvSlot, this.target);
      return db.readSlotPointer(writeMode, path, pathI + 1, targetSlot);
    }
  }
}

export class SortedMapGetIndex implements PathPartBase {
  readonly kind = 'SortedMapGetIndex';
  constructor(public index: number) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_WRITE) throw new WriteNotAllowedException();

    switch (slotPtr.slot.tag) {
      case Tag.NONE:
        throw new KeyNotFoundException();
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET:
        break;
      default:
        throw new UnexpectedTagException();
    }

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

    const found = db.sortedGetByIndex(header.rootPtr, rank);
    // return the entry so the caller can read key and value
    const targetSlot = new SlotPointer(found.position, found.slot);
    return db.readSlotPointer(writeMode, path, pathI + 1, targetSlot);
  }
}

export class SortedMapRemove implements PathPartBase {
  readonly kind = 'SortedMapRemove';
  constructor(public key: Uint8Array) {}

  readSlotPointer(
    db: Database,
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();

    switch (slotPtr.slot.tag) {
      case Tag.NONE:
        throw new KeyNotFoundException();
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET:
        break;
      default:
        throw new UnexpectedTagException();
    }

    slotPtr = db.copyCollectionIfFrozen(slotPtr, new SortedMapInit(slotPtr.slot.tag === Tag.SORTED_SET));
    const headerPtr = Number(slotPtr.slot.value);
    const reader = db.core.reader();
    db.core.seek(headerPtr);
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);

    const result = db.sortedRemove(header.rootPtr, this.key);
    if (!result.found) throw new KeyNotFoundException();

    const writer = db.core.writer();
    db.core.seek(headerPtr);
    writer.write(new BTreeHeader(result.nodePtr, header.size - 1).toBytes());

    return slotPtr;
  }
}

export class WriteData implements PathPartBase {
  readonly kind = 'WriteData';
  constructor(public data: WriteableData | null) {}

  readSlotPointer(
    db: Database,
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
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (writeMode === WriteMode.READ_ONLY) throw new WriteNotAllowedException();
    if (pathI !== path.length - 1) throw new PathPartMustBeAtEndException();

    const nextCursor = new WriteCursor(slotPtr, db);
    this.fn(nextCursor);
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

// lexicographic comparison of two byte strings (unsigned), returns <0, 0, or >0
function compareBytesUnsigned(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function bigIntShiftRight(value: Uint8Array, bits: number): bigint {
  let result = 0n;
  for (let i = 0; i < value.length; i++) {
    result = (result << 8n) | BigInt(value[i]);
  }
  return result >> BigInt(bits);
}

export class Transaction {
  aborted = false;
  // the slot that holds the transaction's root, which remains writable after a freeze
  rootPosition: number | null = null;
  // the copy of the root slot that the transaction works on
  scratchPosition: number | null = null;
  frozenAt: number | null = null;
}

// the size of the chunks that replication copies at a time
const STREAM_CHUNK_SIZE = 64 * 1024;

// for file IDs and commit IDs
function randomU64(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, false);
}

// Database class
export class Database {
  public core: Core;
  public hasher: Hasher;
  public header!: Header;
  public txStart: number | null = null;
  public transaction: Transaction | null = null;

  // `fileId` is the file ID of a new database. if null, a random one is used.
  constructor(core: Core, hasher: Hasher, fileId: bigint | null = null) {
    this.core = core;
    this.hasher = hasher;

    core.seek(0);
    if ((core.length()) === 0) {
      this.header = new Header(fileId ?? randomU64(), hasher.id, hasher.digestLength, VERSION, MAGIC_NUMBER);
      this.header.write(core);
      // write the root header and commit an empty root, so the
      // file ends with a trailer like after any transaction
      core.writer().write(new RootHeader(0, new Slot()).toBytes());
      // the first commit's ID is 0, so a new database's bytes only
      // depend on its file ID
      this.commitRoot(new Slot(), 0n);
      core.sync();
    } else {
      this.header = this.readAndValidateHeader();
      this.committedSize();
    }
  }

  private readAndValidateHeader(): Header {
    this.core.seek(0);
    const header = Header.read(this.core);
    header.validate();
    if (header.hashSize !== this.hasher.digestLength) {
      throw new InvalidHashSizeException();
    }
    return header;
  }

  rootCursor(): WriteCursor {
    // the cursor only holds a snapshot of the root slot, and every operation
    // that starts at it reads the root again. if this read fails, the cursor
    // looks empty and the next operation throws the error.
    let root: Slot;
    try {
      root = this.readRootSlot();
    } catch {
      root = new Slot();
    }
    return new WriteCursor(new SlotPointer(ROOT_HEADER_START, root), this);
  }

  /**
   * runs `fn(cursor)` with a write cursor to the root in a single transaction,
   * discarding everything it wrote if it throws. use it to group writes to a
   * root that isn't an array list, such as a hash map. for an array list root,
   * `appendContext` does the same.
   */
  runContext(fn: ContextFunction): void {
    this.rootCursor().writePath([new Context(fn)]);
  }

  freeze(): void {
    const active = this.transaction;
    if (active === null) throw new ExpectedTxStartException();
    if (this.txStart === null) throw new ExpectedTxStartException();
    this.txStart = this.core.length();
    active.frozenAt = this.txStart;
  }

  /** this database's `ReplicaState`. */
  replicaState(): ReplicaState {
    const committedSize = this.committedSize();
    return { committedSize, checksum: this.readRootTrailer(committedSize).checksum };
  }

  /**
   * where to start sending committed bytes to a replica in `state`. that's
   * its committed size if its bytes are a prefix of this database, or 0 if it
   * must be replaced, because it's a replica of another file or it has
   * diverged from this one.
   */
  replicationStart(state: ReplicaState): number {
    if (state.committedSize > this.committedSize()) return 0;
    let trailer: RootTrailer;
    try {
      trailer = this.readRootTrailer(state.committedSize);
    } catch (e) {
      if (e instanceof InvalidDatabaseException) return 0;
      throw e;
    }
    return trailer.checksum === state.checksum ? state.committedSize : 0;
  }

  /**
   * writes the committed bytes from `start` up to `end` to `writer`. `start`
   * is usually from `replicationStart`, and `end` can't be past
   * `committedSize`. committed bytes never change except for the root header,
   * so when `start` is 0, a root header matching `end` is written, making the
   * bytes a complete database by themselves.
   */
  readCommitted(start: number, end: number, writer: Pick<DataWriter, 'write'>): void {
    if (start < 0 || start > end || end > this.committedSize()) throw new InvalidRangeException();
    if (start > 0 && start < ROOT_HEADER_END) throw new InvalidRangeException();
    if (start === 0) {
      const trailer = this.readRootTrailer(end);
      this.streamTo(writer, 0, ROOT_HEADER_START);
      writer.write(new RootHeader(end, trailer.root).toBytes());
      this.streamTo(writer, ROOT_HEADER_END, end - ROOT_HEADER_END);
    } else {
      this.streamTo(writer, start, end - start);
    }
  }

  /**
   * writes `len` bytes from `reader` at `start` and commits them. they must
   * be the bytes from `readCommitted`, so they end with a trailer. when
   * `start` is 0, this database is replaced by them; otherwise `start` must
   * be this database's `committedSize`.
   */
  applyReplicated(start: number, reader: Pick<DataReader, 'readFully'>, len: number): void {
    const writer = this.openReplicated(start, len);
    let remaining = len;
    while (remaining > 0) {
      const chunk = new Uint8Array(Math.min(remaining, STREAM_CHUNK_SIZE));
      reader.readFully(chunk);
      writer.write(chunk);
      remaining -= chunk.length;
    }
    writer.close();
  }

  /**
   * like `applyReplicated`, but returns a writer to give the `len` bytes to as
   * they arrive, for example from an async network stream. they are written
   * to this database right away, and `close` commits them. if fewer than
   * `len` bytes were written, or they don't end with a trailer, `close` throws
   * and the database stays at its last commit. when `start` is 0, this
   * database is truncated now and replaced by the bytes.
   */
  openReplicated(start: number, len: number): ReplicaWriter {
    if (len < 0) throw new InvalidRangeException();
    if (start === 0) {
      this.core.setLength(0);
    } else if (start === this.committedSize()) {
      // discard anything past the committed bytes, such as the remains of an interrupted sync
      this.truncate();
    } else {
      throw new InvalidRangeException();
    }

    let written = 0;
    let closed = false;
    return {
      write: (chunk: Uint8Array): void => {
        if (closed) throw new Error('replica writer is closed');
        if (chunk.length > len - written) throw new InvalidRangeException();
        this.core.seek(start + written);
        this.core.writer().write(chunk);
        written += chunk.length;
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        if (written !== len) throw new EndOfStreamException();
        this.commitReplicated(start, len);
      },
    };
  }

  // commits `len` bytes written at `start` by a replica writer
  private commitReplicated(start: number, len: number): void {
    if (start === 0) {
      // the bytes are a different database, with its own header
      this.core.sync();
      this.header = this.readAndValidateHeader();
      this.committedSize();
    } else if (len > 0) {
      // the bytes must end with a trailer. update the root header to match it.
      const trailer = this.readRootTrailer(start + len);
      this.core.sync();
      this.writeRootHeader(trailer.root);
      this.core.sync();
    }
  }

  // writes the `len` bytes at `position` to `writer`
  private streamTo(writer: Pick<DataWriter, 'write'>, position: number, len: number): void {
    let remaining = len;
    while (remaining > 0) {
      const chunk = new Uint8Array(Math.min(remaining, STREAM_CHUNK_SIZE));
      this.core.seek(position + len - remaining);
      this.core.reader().readFully(chunk);
      writer.write(chunk);
      remaining -= chunk.length;
    }
  }

  /**
   * clears and borrows the supplied offsets map without disposing it.
   *
   * the target must be a new or empty database, or this throws
   * `TargetNotEmptyException`.
   */
  compact(targetCore: Core, offsetMap: OffsetMap = new Map<number, number>()): Database {
    // cached offsets only apply to this compaction's target
    offsetMap.clear();
    const hasher = new Hasher(this.hasher.algorithm, this.header.hashId);
    const target = new Database(targetCore, hasher);

    // the target must be a new or empty database, because compaction
    // writes to it with ordinary transactions. this also rejects
    // compacting a database into its own file.
    if (!target.readRootSlot().empty()) throw new TargetNotEmptyException();

    const sourceRoot = this.readRootSlot();

    // an empty root compacts to a new database. a root explicitly
    // set to null isn't empty, so it is remapped below.
    if (sourceRoot.empty()) return target;

    // the target is written as one ordinary transaction, so it is committed
    // and fsynced like any other (callers typically rename it over an
    // existing database file). the remap must run inside the transaction,
    // because starting one truncates the target.
    const compactor = new Compactor(this.core, targetCore, this.header.hashSize, offsetMap);
    const remap = (slot: Slot): ContextFunction => (cursor: WriteCursor) => {
      cursor.write(compactor.remapSlot(slot));
    };

    switch (sourceRoot.tag) {
      // an array list root is a history, and its latest moment
      // becomes the only moment of a new one
      case Tag.ARRAY_LIST: {
        const lastMoment = this.rootCursor().readPathSlot([new ArrayListGet(-1)]);
        if (lastMoment !== null) {
          target.rootCursor().writePath([
            new ArrayListInit(),
            new ArrayListAppend(),
            new Context(remap(lastMoment)),
          ]);
        }
        break;
      }
      // any other root is remapped whole
      default:
        target.runContext(remap(sourceRoot));
    }

    return target;
  }

  /**
   * the number of bytes that belong to committed transactions. they never
   * change except for the root header (see `readCommitted`).
   */
  committedSize(): number {
    const header = this.readRootHeader();
    const minimumSize = ROOT_HEADER_END + RootTrailer.LENGTH;
    if (header.fileSize < minimumSize) throw new InvalidDatabaseException();
    if (this.core.length() < header.fileSize) throw new TruncatedDatabaseException();
    // the committed bytes must end with a trailer matching the header
    if (!this.readRootTrailer(header.fileSize).root.equals(header.root)) {
      throw new InvalidDatabaseException();
    }
    return header.fileSize;
  }

  truncate(): void {
    let committedSize = this.committedSize();
    const active = this.transaction;
    if (active !== null && active.frozenAt !== null && active.frozenAt > committedSize) {
      // retain frozen bytes without publishing the failed transaction, ending
      // them with a trailer for the root that is already committed
      if (this.core.length() > active.frozenAt) this.core.setLength(active.frozenAt);
      this.commitRoot(this.readRootSlot(), randomU64());
      this.core.sync();
      committedSize = this.core.length();
    }
    if (this.core.length() > committedSize) {
      this.core.setLength(committedSize);
    }
  }

  readRootHeader(): RootHeader {
    this.core.seek(ROOT_HEADER_START);
    const bytes = new Uint8Array(RootHeader.LENGTH);
    this.core.reader().readFully(bytes);
    return RootHeader.fromBytes(bytes);
  }

  // the most recently committed root slot
  readRootSlot(): Slot {
    return this.readRootHeader().root;
  }

  // the trailer that ends at `end`
  private readRootTrailer(end: number): RootTrailer {
    if (end < RootTrailer.LENGTH) throw new InvalidDatabaseException();
    const trailerPos = end - RootTrailer.LENGTH;
    this.core.seek(trailerPos);
    const bytes = new Uint8Array(RootTrailer.LENGTH);
    this.core.reader().readFully(bytes);
    const rootBytes = bytes.subarray(0, Slot.LENGTH);
    const view = new DataView(bytes.buffer);
    const commitId = view.getBigUint64(Slot.LENGTH, false);
    const checksum = view.getBigUint64(Slot.LENGTH + 8, false);
    if (checksum !== RootTrailer.computeChecksum(this.header.fileId, trailerPos, rootBytes, commitId)) throw new InvalidDatabaseException();
    return new RootTrailer(checksum, commitId, Slot.fromBytes(rootBytes));
  }

  // completes a transaction by appending a trailer for `root` and updating
  // the root header. callers must sync afterwards to make the header itself
  // durable.
  private commitRoot(root: Slot, commitId: bigint): void {
    const trailerPos = this.core.length();
    this.core.seek(trailerPos);
    this.core.writer().write(RootTrailer.init(this.header.fileId, trailerPos, root, commitId).toBytes());

    // flush and fsync before updating the header, because updating
    // the header is what completes the transaction. without the
    // fsync, the OS could persist the header before the data it
    // points to, so a crash could commit a transaction whose data
    // never reached disk.
    this.core.sync();

    this.writeRootHeader(root);
  }

  // points the root header at `root`, which must be in the trailer that ends
  // the file.
  private writeRootHeader(root: Slot): void {
    const fileSize = this.core.length();
    this.core.seek(ROOT_HEADER_START);
    this.core.writer().write(new RootHeader(fileSize, root).toBytes());
  }

  // whether this slot pointer is the root of the database
  static isRoot(slotPtr: SlotPointer): boolean {
    return slotPtr.position === ROOT_HEADER_START;
  }

  // the collection tag that an init path part creates, if any
  private static initTag(part: PathPart): Tag | null {
    switch (part.kind) {
      case 'ArrayListInit':
        return Tag.ARRAY_LIST;
      case 'LinkedArrayListInit':
        return Tag.LINKED_ARRAY_LIST;
      case 'HashMapInit':
        return part.counted
          ? (part.set ? Tag.COUNTED_HASH_SET : Tag.COUNTED_HASH_MAP)
          : (part.set ? Tag.HASH_SET : Tag.HASH_MAP);
      case 'SortedMapInit':
        return part.set ? Tag.SORTED_SET : Tag.SORTED_MAP;
      default:
        return null;
    }
  }

  // the init path part for a collection tag, if any
  private static initPartFor(tag: Tag): PathPart | null {
    switch (tag) {
      case Tag.ARRAY_LIST:
        return new ArrayListInit();
      case Tag.LINKED_ARRAY_LIST:
        return new LinkedArrayListInit();
      case Tag.HASH_MAP:
        return new HashMapInit(false, false);
      case Tag.HASH_SET:
        return new HashMapInit(false, true);
      case Tag.COUNTED_HASH_MAP:
        return new HashMapInit(true, false);
      case Tag.COUNTED_HASH_SET:
        return new HashMapInit(true, true);
      case Tag.SORTED_MAP:
        return new SortedMapInit(false);
      case Tag.SORTED_SET:
        return new SortedMapInit(true);
      default:
        return null;
    }
  }

  // whether the data at `ptr` predates this transaction, so it must be
  // copied before it is modified. writes only happen inside a transaction.
  isOld(ptr: number): boolean {
    if (this.txStart === null) throw new ExpectedTxStartException();
    return ptr < this.txStart;
  }

  // copies an index block to the end unless it was made in this transaction
  copyIndexBlockIfOld(ptr: number): number {
    if (!this.isOld(ptr)) return ptr;
    const indexBlock = new Uint8Array(INDEX_BLOCK_SIZE);
    this.core.seek(ptr);
    this.core.reader().readFully(indexBlock);
    const nextPtr = this.core.length();
    this.core.seek(nextPtr);
    this.core.writer().write(indexBlock);
    return nextPtr;
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

  // reject writes into frozen data; the current transaction's root slot remains writable
  checkFrozenSlot(slotPtr: SlotPointer): void {
    const active = this.transaction;
    if (active !== null && active.frozenAt !== null && slotPtr.position !== null
      && slotPtr.position < active.frozenAt && slotPtr.position !== active.rootPosition) {
      throw new Error('Writer points into frozen data; reacquire it from the transaction root');
    }
  }

  // copy frozen collection storage before mutation to preserve existing readers
  copyCollectionIfFrozen(slotPtr: SlotPointer, init: PathPart): SlotPointer {
    if (this.transaction !== null
      && this.transaction.frozenAt !== null && slotPtr.slot.value < this.transaction.frozenAt) {
      return init.readSlotPointer(this, WriteMode.READ_WRITE, [init], 0, slotPtr);
    }
    return slotPtr;
  }

  readSlotPointer(
    writeMode: WriteMode,
    path: PathPart[],
    pathI: number,
    slotPtr: SlotPointer
  ): SlotPointer {
    if (pathI === path.length) {
      if (writeMode === WriteMode.READ_ONLY && slotPtr.slot.empty()) {
        throw new KeyNotFoundException();
      }
      return slotPtr;
    }

    // every write that starts at the root is a transaction
    if (Database.isRoot(slotPtr)) {
      const root = this.readRootSlot();

      // the position of a read path doesn't matter, but it must not be
      // ROOT_HEADER_START or this would recurse forever
      if (writeMode === WriteMode.READ_ONLY) {
        return this.readSlotPointer(writeMode, path, pathI, new SlotPointer(null, root));
      }

      // initializing an initialized root is free, so a wrapper like
      // `WriteArrayList` can hold a root cursor without a transaction. like
      // starting one, it discards data left by an unfinished transaction.
      // (`writePath` rejects root writes inside a transaction, so none
      // is open here.)
      if (path.length - pathI === 1 && root.tag !== Tag.NONE) {
        const tag = Database.initTag(path[pathI]);
        if (tag !== null && tag === root.tag) {
          this.truncate();
          return new SlotPointer(ROOT_HEADER_START, root);
        }
      }

      // discard data left by an unfinished transaction after a crash
      this.truncate();
      const scratchPos = this.core.length();
      this.txStart = scratchPos;
      try {
        // the transaction works on a copy of the root slot
        this.core.seek(scratchPos);
        this.core.writer().write(root.toBytes());
        let rootPtr = new SlotPointer(scratchPos, root);
        if (this.transaction !== null) {
          this.transaction.rootPosition = scratchPos;
          this.transaction.scratchPosition = scratchPos;
        }

        // every collection expects its init part to copy its header or root
        // block into the transaction before anything writes to it. the root
        // has no enclosing init part, so run one here.
        const initPart = Database.initPartFor(root.tag);
        if (initPart !== null) {
          rootPtr = this.readSlotPointer(writeMode, [initPart], 0, rootPtr);
        }

        let result = this.readSlotPointer(writeMode, path, pathI, rootPtr);

        // the copy now holds the new root, so commit it
        this.core.seek(scratchPos);
        const nextRootBytes = new Uint8Array(Slot.LENGTH);
        this.core.reader().readFully(nextRootBytes);
        const nextRoot = Slot.fromBytes(nextRootBytes);
        this.commitRoot(nextRoot, randomU64());

        // a path that ends at the root (such as an init or a write) returns
        // a root cursor, so it can be used for later transactions
        if (result.position === scratchPos) {
          result = new SlotPointer(ROOT_HEADER_START, nextRoot);
        }
        return result;
      } finally {
        this.txStart = null;
      }
    }

    if (writeMode === WriteMode.READ_WRITE) this.checkFrozenSlot(slotPtr);
    const part = path[pathI];
    return part.readSlotPointer(this, writeMode, path, pathI, slotPtr);
  }

  // HashMap methods
  readMapSlot(
    indexPos: number,
    keyHash: Uint8Array,
    keyOffset: number,
    writeMode: WriteMode,
    target: HashMapGetTarget
  ): HashMapGetResult {
    if (keyOffset > (this.header.hashSize * 8) / BIT_COUNT) {
      throw new KeyOffsetExceededException();
    }

    const reader = this.core.reader();

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
            const writer = this.core.writer();
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
        if (writeMode === WriteMode.READ_WRITE) {
          nextPtr = this.copyIndexBlockIfOld(ptr);
          if (nextPtr !== ptr) {
            // make slot point to the copied block
            const writer = this.core.writer();
            this.core.seek(slotPos);
            writer.write(new Slot(nextPtr, Tag.INDEX).toBytes());
          }
        }
        return this.readMapSlot(nextPtr, keyHash, keyOffset + 1, writeMode, target);
      }
      case Tag.KV_PAIR: {
        this.core.seek(ptr);
        const kvPairBytes = new Uint8Array(KeyValuePair.length(this.header.hashSize));
        reader.readFully(kvPairBytes);
        const kvPair = KeyValuePair.fromBytes(kvPairBytes, this.header.hashSize);

        if (arraysEqual(kvPair.hash, keyHash)) {
          if (writeMode === WriteMode.READ_WRITE) {
            if (this.isOld(ptr)) {
              const writer = this.core.writer();
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
              const writer = this.core.writer();
              if (keyOffset + 1 >= (this.header.hashSize * 8) / BIT_COUNT) {
                throw new KeyOffsetExceededException();
              }
              const nextI = Number(bigIntShiftRight(kvPair.hash, (keyOffset + 1) * BIT_COUNT) & MASK);
              const nextIndexPos = this.core.length();
              this.core.seek(nextIndexPos);
              writer.write(new Uint8Array(INDEX_BLOCK_SIZE));
              this.core.seek(nextIndexPos + Slot.LENGTH * nextI);
              writer.write(slot.toBytes());
              const res = this.readMapSlot(nextIndexPos, keyHash, keyOffset + 1, writeMode, target);
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
    keyOffset: number
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
        nextSlot = this.removeMapSlot(Number(slot.value), keyHash, keyOffset + 1);
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

    // there was more than one used slot, or a single .index slot,
    // so we must keep this index block. update the slot in it,
    // copying the block first unless it belongs to this transaction.
    const nextIndexPos = this.copyIndexBlockIfOld(indexPos);
    this.core.seek(nextIndexPos + Slot.LENGTH * i);
    writer.write(nextSlot.toBytes());
    return new Slot(nextIndexPos, Tag.INDEX);
  }

  // ArrayList methods
  readArrayListSlotAppend(
    header: ArrayListHeader,
    writeMode: WriteMode
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

    let slotPtr = this.readArrayListSlot(indexPos, key, nextShift, writeMode);
    // clear values left by a rollback or slice
    slotPtr = slotPtr.withSlot(new Slot());
    if (slotPtr.position === null) throw new CursorNotWriteableException();
    this.core.seek(slotPtr.position);
    writer.write(slotPtr.slot.toBytes());
    return new ArrayListAppendResult(new ArrayListHeader(indexPos, header.size + 1), slotPtr);
  }

  readArrayListSlot(
    indexPos: number,
    key: number,
    shift: number,
    writeMode: WriteMode
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

            this.core.seek(slotPos);
            writer.write(new Slot(nextIndexPos, Tag.INDEX).toBytes());
            return this.readArrayListSlot(nextIndexPos, key, shift - 1, writeMode);
          }
          default:
            throw new UnreachableException();
        }
      }
      case Tag.INDEX: {
        let nextPtr = ptr;
        if (writeMode === WriteMode.READ_WRITE) {
          nextPtr = this.copyIndexBlockIfOld(ptr);
          if (nextPtr !== ptr) {
            // make slot point to the copied block
            const writer = this.core.writer();
            this.core.seek(slotPos);
            writer.write(new Slot(nextPtr, Tag.INDEX).toBytes());
          }
        }
        return this.readArrayListSlot(nextPtr, key, shift - 1, writeMode);
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
      // the new root may still belong to a past moment. unlike child
      // nodes, root nodes are written directly, so copy it now.
      indexPos = this.copyIndexBlockIfOld(indexPos);
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
  // shared subtrees fall below it here.
  btreeReusable(ptr: number): boolean {
    // nothing can be reused outside a transaction
    try {
      return !this.isOld(ptr);
    } catch (e) {
      if (e instanceof ExpectedTxStartException) return false;
      throw e;
    }
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

  // sorted_map / sorted_set

  readSortedNode(ptr: number): SortedNode {
    this.core.seek(ptr);
    const reader = this.core.reader();
    const headerBytes = new Uint8Array(BTREE_NODE_HEADER_SIZE);
    reader.readFully(headerBytes);
    const kindInt = headerBytes[0];
    if (kindInt > BTreeNodeKind.BRANCH) throw new InvalidBTreeNodeKindException();
    const kind = kindInt as BTreeNodeKind;
    const num = headerBytes[1];
    if (num > BTREE_SLOT_COUNT) throw new InvalidBTreeNodeException();
    const node = new SortedNode(kind, num);
    switch (kind) {
      case BTreeNodeKind.LEAF: {
        const body = new Uint8Array(Slot.LENGTH * BTREE_SLOT_COUNT);
        reader.readFully(body);
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          node.entries[i] = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
        }
        break;
      }
      case BTreeNodeKind.BRANCH: {
        const body = new Uint8Array((Slot.LENGTH * 2 + 8) * BTREE_SLOT_COUNT);
        reader.readFully(body);
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          node.children[i] = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
        }
        const sepOffset = Slot.LENGTH * BTREE_SLOT_COUNT;
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          node.separators[i] = Slot.fromBytes(body.slice(sepOffset + i * Slot.LENGTH, sepOffset + i * Slot.LENGTH + Slot.LENGTH));
        }
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const countsOffset = Slot.LENGTH * 2 * BTREE_SLOT_COUNT;
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          node.counts[i] = Number(view.getBigInt64(countsOffset + i * 8, false));
        }
        break;
      }
    }
    return node;
  }

  writeSortedNodeAt(node: SortedNode, ptr: number): void {
    this.core.seek(ptr);
    const writer = this.core.writer();
    const bodySize = node.kind === BTreeNodeKind.LEAF ? SORTED_LEAF_BLOCK_SIZE : SORTED_BRANCH_BLOCK_SIZE;
    const buffer = new Uint8Array(bodySize);
    buffer[0] = node.kind;
    buffer[1] = node.num;
    let off = BTREE_NODE_HEADER_SIZE;
    switch (node.kind) {
      case BTreeNodeKind.LEAF:
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          buffer.set(node.entries[i].toBytes(), off);
          off += Slot.LENGTH;
        }
        break;
      case BTreeNodeKind.BRANCH: {
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          buffer.set(node.children[i].toBytes(), off);
          off += Slot.LENGTH;
        }
        for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
          buffer.set(node.separators[i].toBytes(), off);
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

  writeSortedNode(node: SortedNode): number {
    const ptr = this.core.length();
    this.writeSortedNodeAt(node, ptr);
    return ptr;
  }

  // reuse oldPtr's position in place when it belongs to this transaction
  // (mirrors btreeWriteNode / the txStart path-copying model)
  sortedWriteNode(node: SortedNode, oldPtr: number): number {
    if (this.btreeReusable(oldPtr)) {
      this.writeSortedNodeAt(node, oldPtr);
      return oldPtr;
    }
    return this.writeSortedNode(node);
  }

  readKvPair(kvSlot: Slot): KeyValuePair {
    this.core.seek(Number(kvSlot.value));
    return decodeKvPair(this.core.reader(), kvSlot.tag, this.header.hashSize);
  }

  // writes a .kv_pair or .sorted_kv_pair entry at the end and returns its slot
  writeKvPair(tag: Tag, kvPair: KeyValuePair): Slot {
    const pos = this.core.length();
    this.core.seek(pos);
    encodeKvPair(this.core.writer(), tag, kvPair);
    return new Slot(pos, tag);
  }

  // lexicographic comparison of the byte key stored at keySlot (a bytes or short_bytes
  // slot) against the in-memory target. returns <0, 0, or >0. streams external bytes so
  // keys of any length work without allocation.
  compareKey(keySlot: Slot, target: Uint8Array): number {
    switch (keySlot.tag) {
      case Tag.SHORT_BYTES: {
        const buf = new Uint8Array(8);
        new DataView(buf.buffer).setBigInt64(0, keySlot.value, false);
        const total = keySlot.full ? 6 : 8;
        let len = total;
        for (let i = 0; i < total; i++) {
          if (buf[i] === 0) { len = i; break; }
        }
        return compareBytesUnsigned(buf.subarray(0, len), target);
      }
      case Tag.BYTES: {
        const reader = this.core.reader();
        this.core.seek(Number(keySlot.value));
        const len = reader.readLong();
        let i = 0;
        while (i < len) {
          const n = Math.min(256, len - i);
          const chunk = new Uint8Array(n);
          reader.readFully(chunk);
          for (let j = 0; j < n; j++) {
            const ti = i + j;
            if (ti >= target.length) return 1; // stored has more, equal so far
            const b = chunk[j];
            const t = target[ti];
            if (b < t) return -1;
            if (b > t) return 1;
          }
          i += n;
        }
        return target.length > len ? -1 : 0;
      }
      default:
        throw new UnexpectedTagException();
    }
  }

  // descend by key to the matching leaf entry, or null
  sortedGet(rootPtr: number, key: Uint8Array): SortedSlot | null {
    let nodePtr = rootPtr;
    while (true) {
      const node = this.readSortedNode(nodePtr);
      if (node.kind === BTreeNodeKind.LEAF) {
        for (let i = 0; i < node.num; i++) {
          const entry = node.entries[i];
          const kv = this.readKvPair(entry);
          const cmp = this.compareKey(kv.keySlot, key);
          if (cmp === 0) return new SortedSlot(entry, nodePtr + BTREE_NODE_HEADER_SIZE + i * Slot.LENGTH);
          if (cmp > 0) return null;
        }
        return null;
      } else {
        let i = 0;
        while (i + 1 < node.num && this.compareKey(node.separators[i + 1], key) <= 0) i++;
        nodePtr = Number(node.children[i].value);
      }
    }
  }

  // descend by rank to the leaf entry at the given 0-based index
  sortedGetByIndex(rootPtr: number, rank: number): SortedSlot {
    let nodePtr = rootPtr;
    let rem = rank;
    while (true) {
      const node = this.readSortedNode(nodePtr);
      if (node.kind === BTreeNodeKind.LEAF) {
        const i = rem;
        return new SortedSlot(node.entries[i], nodePtr + BTREE_NODE_HEADER_SIZE + i * Slot.LENGTH);
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

  // number of keys strictly less than key (the inverse of getByIndex)
  sortedRank(rootPtr: number, key: Uint8Array): number {
    let nodePtr = rootPtr;
    let rank = 0;
    while (true) {
      const node = this.readSortedNode(nodePtr);
      if (node.kind === BTreeNodeKind.LEAF) {
        for (let i = 0; i < node.num; i++) {
          const kv = this.readKvPair(node.entries[i]);
          if (this.compareKey(kv.keySlot, key) < 0) rank += 1;
          else break;
        }
        return rank;
      } else {
        let i = 0;
        while (i + 1 < node.num && this.compareKey(node.separators[i + 1], key) <= 0) {
          rank += node.counts[i];
          i++;
        }
        nodePtr = Number(node.children[i].value);
      }
    }
  }

  // write a byte key as a short_bytes (inline, <=8 bytes, no interior zero) or external
  // bytes slot
  writeKey(key: Uint8Array): Slot {
    let hasZero = false;
    for (const b of key) {
      if (b === 0) { hasZero = true; break; }
    }
    if (key.length <= 8 && !hasZero) {
      const value = new Uint8Array(8);
      value.set(key, 0);
      const v = new DataView(value.buffer).getBigInt64(0, false);
      return new Slot(v, Tag.SHORT_BYTES);
    }
    const writer = this.core.writer();
    const pos = this.core.length();
    this.core.seek(pos);
    writer.writeLong(key.length);
    writer.write(key);
    return new Slot(pos, Tag.BYTES);
  }

  // materialize a new leaf entry: write the key bytes and a key-value pair with an
  // empty value (the caller fills it in). navigation is by key bytes, so the entry
  // has no hash.
  sortedNewEntry(key: Uint8Array): SortedEntry {
    const keySlot = this.writeKey(key);
    const kvSlot = this.writeKvPair(Tag.SORTED_KV_PAIR, new KeyValuePair(new Slot(), keySlot, new Uint8Array(this.header.hashSize)));
    return new SortedEntry(kvSlot, keySlot);
  }

  // insert key (or locate it for replacement) within the subtree at nodePtr,
  // path-copying nodes and maintaining separators + counts. the caller writes the value
  // of the returned entry.
  sortedPut(nodePtr: number, key: Uint8Array): SortedInsertResult {
    const node = this.readSortedNode(nodePtr);
    switch (node.kind) {
      case BTreeNodeKind.LEAF: {
        // find the matching or insertion index
        let idx = node.num;
        let found = false;
        for (let i = 0; i < node.num; i++) {
          const kv = this.readKvPair(node.entries[i]);
          const cmp = this.compareKey(kv.keySlot, key);
          if (cmp === 0) { idx = i; found = true; break; }
          if (cmp > 0) { idx = i; break; }
        }

        if (found) {
          // replace: return a writable value slot, copy-on-writing the kv_pair if it
          // belongs to a past moment
          const leaf = node;
          let kvSlot = node.entries[idx];
          if (!this.btreeReusable(Number(kvSlot.value))) {
            kvSlot = this.writeKvPair(kvSlot.tag, this.readKvPair(kvSlot));
            leaf.entries[idx] = kvSlot;
          }
          const ptr = this.sortedWriteNode(leaf, nodePtr);
          return new SortedInsertResult(ptr, node.num, kvSlot, false, null);
        }

        // insert a new entry at idx
        const entry = this.sortedNewEntry(key);
        const entries: Slot[] = [];
        for (let k = 0; k < idx; k++) entries.push(node.entries[k]);
        entries.push(entry.kvSlot);
        for (let k = idx; k < node.num; k++) entries.push(node.entries[k]);
        const total = node.num + 1;

        if (total <= BTREE_SLOT_COUNT) {
          const leaf = new SortedNode(BTreeNodeKind.LEAF, total);
          for (let k = 0; k < total; k++) leaf.entries[k] = entries[k];
          const ptr = this.sortedWriteNode(leaf, nodePtr);
          return new SortedInsertResult(ptr, total, entry.kvSlot, true, null);
        }

        // overflow: split into two leaves; the new sibling's separator is the key of its
        // first entry
        const leftN = BTREE_SPLIT_COUNT;
        const rightN = total - leftN;
        const left = new SortedNode(BTreeNodeKind.LEAF, leftN);
        for (let k = 0; k < leftN; k++) left.entries[k] = entries[k];
        const right = new SortedNode(BTreeNodeKind.LEAF, rightN);
        for (let k = 0; k < rightN; k++) right.entries[k] = entries[leftN + k];
        const separator = this.readKvPair(entries[leftN]).keySlot;
        const leftPtr = this.sortedWriteNode(left, nodePtr);
        const rightPtr = this.writeSortedNode(right);
        return new SortedInsertResult(leftPtr, leftN, entry.kvSlot, true, new SortedSplit(rightPtr, rightN, separator));
      }
      case BTreeNodeKind.BRANCH: {
        let i = 0;
        while (i + 1 < node.num && this.compareKey(node.separators[i + 1], key) <= 0) i++;
        const child = this.sortedPut(Number(node.children[i].value), key);

        const children: Slot[] = [];
        const separators: Slot[] = [];
        const counts: number[] = [];
        for (let k = 0; k < node.num; k++) {
          children.push(node.children[k]);
          separators.push(node.separators[k]);
          counts.push(node.counts[k]);
        }
        children[i] = new Slot(child.nodePtr, Tag.INDEX);
        counts[i] = child.count;
        let total = node.num;
        if (child.split !== null) {
          children.splice(i + 1, 0, new Slot(child.split.nodePtr, Tag.INDEX));
          separators.splice(i + 1, 0, child.split.separator);
          counts.splice(i + 1, 0, child.split.count);
          total = node.num + 1;
        }

        if (total <= BTREE_SLOT_COUNT) {
          const branch = new SortedNode(BTreeNodeKind.BRANCH, total);
          for (let k = 0; k < total; k++) {
            branch.children[k] = children[k];
            branch.separators[k] = separators[k];
            branch.counts[k] = counts[k];
          }
          const ptr = this.sortedWriteNode(branch, nodePtr);
          return new SortedInsertResult(ptr, branch.subtreeCount(), child.kvSlot, child.added, null);
        }

        // overflow: split into two branches; the new sibling's separator is the smallest
        // key of its first child (separators[leftN] of the combined)
        const leftN = BTREE_SPLIT_COUNT;
        const rightN = total - leftN;
        const left = new SortedNode(BTreeNodeKind.BRANCH, leftN);
        for (let k = 0; k < leftN; k++) {
          left.children[k] = children[k];
          left.separators[k] = separators[k];
          left.counts[k] = counts[k];
        }
        const right = new SortedNode(BTreeNodeKind.BRANCH, rightN);
        for (let k = 0; k < rightN; k++) {
          right.children[k] = children[leftN + k];
          right.separators[k] = separators[leftN + k];
          right.counts[k] = counts[leftN + k];
        }
        const separator = separators[leftN];
        const leftPtr = this.sortedWriteNode(left, nodePtr);
        const rightPtr = this.writeSortedNode(right);
        return new SortedInsertResult(
          leftPtr,
          left.subtreeCount(),
          child.kvSlot,
          child.added,
          new SortedSplit(rightPtr, right.subtreeCount(), separator)
        );
      }
    }
    throw new UnreachableException();
  }

  // remove key from the subtree at nodePtr, path-copying nodes and decrementing counts.
  // an emptied leaf is left in place (see SortedRemoveResult).
  sortedRemove(nodePtr: number, key: Uint8Array): SortedRemoveResult {
    const node = this.readSortedNode(nodePtr);
    switch (node.kind) {
      case BTreeNodeKind.LEAF: {
        let idx = node.num;
        let found = false;
        for (let i = 0; i < node.num; i++) {
          const kv = this.readKvPair(node.entries[i]);
          const cmp = this.compareKey(kv.keySlot, key);
          if (cmp === 0) { idx = i; found = true; break; }
          if (cmp > 0) break;
        }
        if (!found) return new SortedRemoveResult(nodePtr, false);

        const leaf = new SortedNode(BTreeNodeKind.LEAF, node.num - 1);
        for (let k = 0; k < idx; k++) leaf.entries[k] = node.entries[k];
        for (let k = idx; k < node.num - 1; k++) leaf.entries[k] = node.entries[k + 1];
        const ptr = this.sortedWriteNode(leaf, nodePtr);
        return new SortedRemoveResult(ptr, true);
      }
      case BTreeNodeKind.BRANCH: {
        let i = 0;
        while (i + 1 < node.num && this.compareKey(node.separators[i + 1], key) <= 0) i++;
        const child = this.sortedRemove(Number(node.children[i].value), key);
        if (!child.found) return new SortedRemoveResult(nodePtr, false);

        const branch = node;
        branch.children[i] = new Slot(child.nodePtr, Tag.INDEX);
        branch.counts[i] -= 1;
        const ptr = this.sortedWriteNode(branch, nodePtr);
        return new SortedRemoveResult(ptr, true);
      }
    }
    throw new UnreachableException();
  }

  sortedGrowRoot(result: SortedInsertResult): number {
    if (result.split !== null) {
      const split = result.split;
      const root = new SortedNode(BTreeNodeKind.BRANCH, 2);
      root.children[0] = new Slot(result.nodePtr, Tag.INDEX);
      root.children[1] = new Slot(split.nodePtr, Tag.INDEX);
      root.separators[1] = split.separator; // separators[0] is an unused sentinel
      root.counts[0] = result.count;
      root.counts[1] = split.count;
      return this.writeSortedNode(root);
    }
    return result.nodePtr;
  }

  // turn a located/inserted entry into the slot for the requested target. only the
  // value is writeable (that is how put works); the key and the entry pointer are
  // immutable, so they are returned with no writeable position.
  sortedTargetSlot(kvSlot: Slot, target: SortedMapGetTarget): SlotPointer {
    const kv = this.readKvPair(kvSlot);
    if (target instanceof SortedMapGetKVPair) {
      return new SlotPointer(null, kvSlot);
    } else if (target instanceof SortedMapGetKey) {
      return new SlotPointer(null, kv.keySlot);
    } else if (target instanceof SortedMapGetValue) {
      return new SlotPointer(Number(kvSlot.value) + kvKeyOffset(kvSlot.tag, this.header.hashSize) + Slot.LENGTH, kv.valueSlot);
    } else {
      throw new UnexpectedTagException();
    }
  }
}

// compaction helpers

class Compactor {
  constructor(
    private readonly sourceCore: Core,
    private readonly targetCore: Core,
    private readonly hashSize: number,
    private readonly offsetMap: OffsetMap
  ) {}

  private reserveBlock(size: number): number {
    const offset = this.targetCore.length();
    this.targetCore.seek(offset);
    this.targetCore.writer().write(new Uint8Array(size));
    return offset;
  }

  private visitObject(
    sourceOffset: number,
    size: number,
    populate: (sourceOffset: number, targetOffset: number) => void
  ): number {
    const mapped = this.offsetMap.get(sourceOffset);
    if (mapped !== undefined) return mapped;

    const targetOffset = this.reserveBlock(size);
    this.offsetMap.set(sourceOffset, targetOffset);
    populate(sourceOffset, targetOffset);
    return targetOffset;
  }

  remapSlot(slot: Slot): Slot {
    switch (slot.tag) {
      case Tag.NONE:
      case Tag.UINT:
      case Tag.INT:
      case Tag.FLOAT:
      case Tag.SHORT_BYTES:
        return slot;
      case Tag.BYTES: {
        const newOffset = this.remapBytes(slot);
        return new Slot(newOffset, slot.tag, slot.full);
      }
      case Tag.INDEX: {
        const newOffset = this.visitObject(Number(slot.value), INDEX_BLOCK_SIZE, (source, target) => this.populateIndex(source, target));
        return new Slot(newOffset, slot.tag, slot.full);
      }
      case Tag.ARRAY_LIST: {
        const newOffset = this.visitObject(Number(slot.value), ArrayListHeader.LENGTH, (source, target) => this.populateArrayList(source, target));
        return new Slot(newOffset, slot.tag, slot.full);
      }
      case Tag.LINKED_ARRAY_LIST: {
        const newOffset = this.visitObject(Number(slot.value), BTreeHeader.LENGTH, (source, target) => this.populateBTree(source, target));
        return new Slot(newOffset, slot.tag, slot.full);
      }
      case Tag.HASH_MAP:
      case Tag.HASH_SET: {
        const newOffset = this.visitObject(Number(slot.value), INDEX_BLOCK_SIZE, (source, target) => this.populateHashMapOrSet(source, target, false));
        return new Slot(newOffset, slot.tag, slot.full);
      }
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET: {
        const newOffset = this.visitObject(Number(slot.value), INDEX_BLOCK_SIZE + 8, (source, target) => this.populateHashMapOrSet(source, target, true));
        return new Slot(newOffset, slot.tag, slot.full);
      }
      case Tag.KV_PAIR: {
        const newOffset = this.visitObject(Number(slot.value), KeyValuePair.length(this.hashSize), (source, target) => this.populateKvPair(source, target, Tag.KV_PAIR));
        return new Slot(newOffset, slot.tag, slot.full);
      }
      case Tag.SORTED_KV_PAIR: {
        const newOffset = this.visitObject(Number(slot.value), SortedKeyValuePair.LENGTH, (source, target) => this.populateKvPair(source, target, Tag.SORTED_KV_PAIR));
        return new Slot(newOffset, slot.tag, slot.full);
      }
      case Tag.SORTED_MAP:
      case Tag.SORTED_SET: {
        const newOffset = this.visitObject(Number(slot.value), BTreeHeader.LENGTH, (source, target) => this.populateSortedMap(source, target));
        return new Slot(newOffset, slot.tag, slot.full);
      }
      default:
        throw new UnexpectedTagException();
    }
  }

  private remapBytes(slot: Slot): number {
    const mapped = this.offsetMap.get(Number(slot.value));
    if (mapped !== undefined) return mapped;

    this.sourceCore.seek(Number(slot.value));
    const sourceReader = this.sourceCore.reader();
    const length = sourceReader.readLong();

    // total size: 8-byte length + bytes + optional 2-byte format_tag
    const formatTagSize = slot.full ? 2 : 0;
    const totalPayload = length + formatTagSize;

    const newOffset = this.targetCore.length();
    this.targetCore.seek(newOffset);
    const targetWriter = this.targetCore.writer();
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

    this.offsetMap.set(Number(slot.value), newOffset);
    return newOffset;
  }

  private populateIndex(sourceOffset: number, targetOffset: number): void {
    // read 144-byte block (16 slots)
    this.sourceCore.seek(sourceOffset);
    const sourceReader = this.sourceCore.reader();
    const blockBytes = new Uint8Array(INDEX_BLOCK_SIZE);
    sourceReader.readFully(blockBytes);

    // remap each slot
    const remappedSlots: Slot[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slotBytes = blockBytes.slice(i * Slot.LENGTH, (i + 1) * Slot.LENGTH);
      const childSlot = Slot.fromBytes(slotBytes);
      remappedSlots.push(this.remapSlot(childSlot));
    }

    // write remapped block to target
    this.targetCore.seek(targetOffset);
    const targetWriter = this.targetCore.writer();
    for (const s of remappedSlots) {
      targetWriter.write(s.toBytes());
    }
  }

  private remapArrayListIndex(sourceOffset: number, size: number, shift: number): number {
    const childSize = 2 ** (shift * BIT_COUNT);

    // full blocks can use the normal cache. partial blocks may
    // be shared by lists with different sizes, so copy them
    // separately and leave the slots beyond the size empty.
    if (size === childSize * SLOT_COUNT) {
      return Number(this.remapSlot(new Slot(sourceOffset, Tag.INDEX)).value);
    }

    const targetOffset = this.reserveBlock(INDEX_BLOCK_SIZE);
    this.sourceCore.seek(sourceOffset);
    const blockBytes = new Uint8Array(INDEX_BLOCK_SIZE);
    this.sourceCore.reader().readFully(blockBytes);
    const remappedBlock = new Uint8Array(INDEX_BLOCK_SIZE);
    let remaining = size;
    for (let i = 0; i < SLOT_COUNT && remaining > 0; i++) {
      const slotBytes = blockBytes.slice(i * Slot.LENGTH, (i + 1) * Slot.LENGTH);
      const childSlot = Slot.fromBytes(slotBytes);
      const count = Math.min(remaining, childSize);
      let remappedSlot: Slot;
      if (shift === 0) {
        remappedSlot = this.remapSlot(childSlot);
      } else {
        if (childSlot.tag !== Tag.INDEX) throw new UnexpectedTagException();
        const childOffset = this.remapArrayListIndex(Number(childSlot.value), count, shift - 1);
        remappedSlot = new Slot(childOffset, childSlot.tag, childSlot.full);
      }
      remappedBlock.set(remappedSlot.toBytes(), i * Slot.LENGTH);
      remaining -= count;
    }

    this.targetCore.seek(targetOffset);
    this.targetCore.writer().write(remappedBlock);
    return targetOffset;
  }

  private populateArrayList(sourceOffset: number, targetOffset: number): void {
    // read ArrayListHeader (16 bytes)
    this.sourceCore.seek(sourceOffset);
    const sourceReader = this.sourceCore.reader();
    const headerBytes = new Uint8Array(ArrayListHeader.LENGTH);
    sourceReader.readFully(headerBytes);
    const header = ArrayListHeader.fromBytes(headerBytes);

    const shift = header.size <= SLOT_COUNT ? 0 : Math.floor(Math.log(header.size - 1) / Math.log(SLOT_COUNT));
    const remappedIndex = this.remapArrayListIndex(header.ptr, header.size, shift);

    // write new ArrayListHeader with remapped ptr
    this.targetCore.seek(targetOffset);
    const targetWriter = this.targetCore.writer();
    targetWriter.write(new ArrayListHeader(remappedIndex, header.size).toBytes());
  }

  private populateBTree(sourceOffset: number, targetOffset: number): void {
    this.sourceCore.seek(sourceOffset);
    const sourceReader = this.sourceCore.reader();
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    sourceReader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);

    const remappedRoot = this.remapBTreeNode(header.rootPtr);

    this.targetCore.seek(targetOffset);
    const targetWriter = this.targetCore.writer();
    targetWriter.write(new BTreeHeader(remappedRoot, header.size).toBytes());
  }

  private remapBTreeNode(nodeOffset: number): number {
    // dedup check (subtrees are shared by pointer)
    const mapped = this.offsetMap.get(nodeOffset);
    if (mapped !== undefined) return mapped;

    this.sourceCore.seek(nodeOffset);
    const sourceReader = this.sourceCore.reader();
    const nodeHeader = new Uint8Array(BTREE_NODE_HEADER_SIZE);
    sourceReader.readFully(nodeHeader);
    const kindInt = nodeHeader[0];
    if (kindInt > BTreeNodeKind.BRANCH) throw new InvalidBTreeNodeKindException();
    const kind = kindInt as BTreeNodeKind;
    const num = nodeHeader[1];
    if (num > BTREE_SLOT_COUNT) throw new InvalidBTreeNodeException();

    switch (kind) {
      case BTreeNodeKind.LEAF: {
        return this.visitObject(nodeOffset, BTREE_LEAF_BLOCK_SIZE, (source, target) =>
          this.populateBTreeLeaf(source, target, kindInt, num)
        );
      }
      case BTreeNodeKind.BRANCH: {
        return this.visitObject(nodeOffset, BTREE_BRANCH_BLOCK_SIZE, (source, target) =>
          this.populateBTreeBranch(source, target, kindInt, num)
        );
      }
    }
    throw new UnreachableException();
  }

  private populateBTreeLeaf(sourceOffset: number, targetOffset: number, kind: number, num: number): void {
    this.sourceCore.seek(sourceOffset + BTREE_NODE_HEADER_SIZE);
    const sourceReader = this.sourceCore.reader();
    const body = new Uint8Array(Slot.LENGTH * BTREE_SLOT_COUNT);
    sourceReader.readFully(body);

    const slots: Slot[] = [];
    for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
      const valueSlot = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
      slots.push(this.remapSlot(valueSlot));
    }

    this.targetCore.seek(targetOffset);
    const targetWriter = this.targetCore.writer();
    targetWriter.write(new Uint8Array([kind, num]));
    for (const slot of slots) targetWriter.write(slot.toBytes());
  }

  private populateBTreeBranch(sourceOffset: number, targetOffset: number, kind: number, num: number): void {
    this.sourceCore.seek(sourceOffset + BTREE_NODE_HEADER_SIZE);
    const sourceReader = this.sourceCore.reader();
    const body = new Uint8Array((Slot.LENGTH + 8) * BTREE_SLOT_COUNT);
    sourceReader.readFully(body);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

    const children: Slot[] = [];
    for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
      const child = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
      if (child.tag === Tag.INDEX) {
        const remappedPtr = this.remapBTreeNode(Number(child.value));
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

    this.targetCore.seek(targetOffset);
    const targetWriter = this.targetCore.writer();
    targetWriter.write(new Uint8Array([kind, num]));
    for (const child of children) targetWriter.write(child.toBytes());
    for (const count of counts) targetWriter.writeLong(count);
  }

  private populateSortedMap(sourceOffset: number, targetOffset: number): void {
    this.sourceCore.seek(sourceOffset);
    const sourceReader = this.sourceCore.reader();
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    sourceReader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);

    const remappedRoot = this.remapSortedMapNode(header.rootPtr);

    this.targetCore.seek(targetOffset);
    const targetWriter = this.targetCore.writer();
    targetWriter.write(new BTreeHeader(remappedRoot, header.size).toBytes());
  }

  private remapSortedMapNode(nodeOffset: number): number {
    const mapped = this.offsetMap.get(nodeOffset);
    if (mapped !== undefined) return mapped;

    this.sourceCore.seek(nodeOffset);
    const sourceReader = this.sourceCore.reader();
    const nodeHeader = new Uint8Array(BTREE_NODE_HEADER_SIZE);
    sourceReader.readFully(nodeHeader);
    const kindInt = nodeHeader[0];
    if (kindInt > BTreeNodeKind.BRANCH) throw new InvalidBTreeNodeKindException();
    const kind = kindInt as BTreeNodeKind;
    const num = nodeHeader[1];
    if (num > BTREE_SLOT_COUNT) throw new InvalidBTreeNodeException();

    switch (kind) {
      case BTreeNodeKind.LEAF: {
        return this.visitObject(nodeOffset, SORTED_LEAF_BLOCK_SIZE, (source, target) =>
          this.populateSortedMapLeaf(source, target, kindInt, num)
        );
      }
      case BTreeNodeKind.BRANCH: {
        return this.visitObject(nodeOffset, SORTED_BRANCH_BLOCK_SIZE, (source, target) =>
          this.populateSortedMapBranch(source, target, kindInt, num)
        );
      }
    }
    throw new UnreachableException();
  }

  private populateSortedMapLeaf(sourceOffset: number, targetOffset: number, kind: number, num: number): void {
    this.sourceCore.seek(sourceOffset + BTREE_NODE_HEADER_SIZE);
    const sourceReader = this.sourceCore.reader();
    const body = new Uint8Array(Slot.LENGTH * BTREE_SLOT_COUNT);
    sourceReader.readFully(body);

    const entries: Slot[] = [];
    for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
      const entry = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
      entries.push(this.remapSlot(entry));
    }

    this.targetCore.seek(targetOffset);
    const targetWriter = this.targetCore.writer();
    targetWriter.write(new Uint8Array([kind, num]));
    for (const entry of entries) targetWriter.write(entry.toBytes());
  }

  private populateSortedMapBranch(sourceOffset: number, targetOffset: number, kind: number, num: number): void {
    this.sourceCore.seek(sourceOffset + BTREE_NODE_HEADER_SIZE);
    const sourceReader = this.sourceCore.reader();
    const body = new Uint8Array((Slot.LENGTH * 2 + 8) * BTREE_SLOT_COUNT);
    sourceReader.readFully(body);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

    const children: Slot[] = [];
    for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
      const child = Slot.fromBytes(body.slice(i * Slot.LENGTH, i * Slot.LENGTH + Slot.LENGTH));
      if (child.tag === Tag.INDEX) {
        const remappedPtr = this.remapSortedMapNode(Number(child.value));
        children.push(new Slot(remappedPtr, Tag.INDEX, child.full));
      } else {
        children.push(child);
      }
    }
    const separatorOffset = Slot.LENGTH * BTREE_SLOT_COUNT;
    const separators: Slot[] = [];
    for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
      const separator = Slot.fromBytes(body.slice(separatorOffset + i * Slot.LENGTH, separatorOffset + (i + 1) * Slot.LENGTH));
      separators.push(this.remapSlot(separator));
    }
    const countsOffset = Slot.LENGTH * 2 * BTREE_SLOT_COUNT;
    const counts: number[] = [];
    for (let i = 0; i < BTREE_SLOT_COUNT; i++) {
      counts.push(Number(view.getBigInt64(countsOffset + i * 8, false)));
    }

    this.targetCore.seek(targetOffset);
    const targetWriter = this.targetCore.writer();
    targetWriter.write(new Uint8Array([kind, num]));
    for (const child of children) targetWriter.write(child.toBytes());
    for (const separator of separators) targetWriter.write(separator.toBytes());
    for (const count of counts) targetWriter.writeLong(count);
  }

  private populateHashMapOrSet(sourceOffset: number, targetOffset: number, counted: boolean): void {
    this.sourceCore.seek(sourceOffset);
    const sourceReader = this.sourceCore.reader();

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
      remappedSlots.push(this.remapSlot(childSlot));
    }

    // write [optional count][remapped block] contiguously to target
    this.targetCore.seek(targetOffset);
    const targetWriter = this.targetCore.writer();
    if (counted) {
      targetWriter.writeLong(countValue);
    }
    for (const s of remappedSlots) {
      targetWriter.write(s.toBytes());
    }
  }

  private populateKvPair(sourceOffset: number, targetOffset: number, tag: Tag): void {
    this.sourceCore.seek(sourceOffset);
    const kvPair = decodeKvPair(this.sourceCore.reader(), tag, this.hashSize);

    // remap key_slot and value_slot, and write the pair in the same form
    kvPair.keySlot = this.remapSlot(kvPair.keySlot);
    kvPair.valueSlot = this.remapSlot(kvPair.valueSlot);
    this.targetCore.seek(targetOffset);
    encodeKvPair(this.targetCore.writer(), tag, kvPair);
  }
}

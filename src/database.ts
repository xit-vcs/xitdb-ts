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
} from './exceptions.js';
import { Bytes, Float, Int, Uint, type WriteableData } from './writeable-data.js';
import { WriteCursor } from './write-cursor.js';

export const VERSION = 0;
export const MAGIC_NUMBER = new Uint8Array([0x78, 0x69, 0x74]); // 'xit'
export const BIT_COUNT = 4;
export const SLOT_COUNT = 1 << BIT_COUNT;
export const MASK = BigInt(SLOT_COUNT - 1);
export const INDEX_BLOCK_SIZE = Slot.LENGTH * SLOT_COUNT;
export const LINKED_ARRAY_LIST_SLOT_LENGTH = 8 + Slot.LENGTH;
export const LINKED_ARRAY_LIST_INDEX_BLOCK_SIZE = LINKED_ARRAY_LIST_SLOT_LENGTH * SLOT_COUNT;
export const MAX_BRANCH_LENGTH = 16;

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

// LinkedArrayListHeader
export class LinkedArrayListHeader {
  static readonly LENGTH = 17;

  constructor(public shift: number, public ptr: number, public size: number) {}

  toBytes(): Uint8Array {
    const buffer = new ArrayBuffer(LinkedArrayListHeader.LENGTH);
    const view = new DataView(buffer);
    view.setBigInt64(0, BigInt(this.size), false);
    view.setBigInt64(8, BigInt(this.ptr), false);
    view.setUint8(16, this.shift & 0b0011_1111);
    return new Uint8Array(buffer);
  }

  static fromBytes(bytes: Uint8Array): LinkedArrayListHeader {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = Number(view.getBigInt64(0, false));
    checkLong(size);
    const ptr = Number(view.getBigInt64(8, false));
    checkLong(ptr);
    const shift = view.getUint8(16) & 0b0011_1111;
    return new LinkedArrayListHeader(shift, ptr, size);
  }

  withPtr(ptr: number): LinkedArrayListHeader {
    return new LinkedArrayListHeader(this.shift, ptr, this.size);
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

// LinkedArrayListSlot
export class LinkedArrayListSlot {
  static readonly LENGTH = 8 + Slot.LENGTH;

  constructor(public size: number, public slot: Slot) {}

  withSize(size: number): LinkedArrayListSlot {
    return new LinkedArrayListSlot(size, this.slot);
  }

  toBytes(): Uint8Array {
    const buffer = new ArrayBuffer(LinkedArrayListSlot.LENGTH);
    const view = new DataView(buffer);
    const arr = new Uint8Array(buffer);
    arr.set(this.slot.toBytes(), 0);
    view.setBigInt64(Slot.LENGTH, BigInt(this.size), false);
    return arr;
  }

  static fromBytes(bytes: Uint8Array): LinkedArrayListSlot {
    const slotBytes = bytes.slice(0, Slot.LENGTH);
    const slot = Slot.fromBytes(slotBytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = Number(view.getBigInt64(Slot.LENGTH, false));
    checkLong(size);
    return new LinkedArrayListSlot(size, slot);
  }
}

// LinkedArrayListSlotPointer
export class LinkedArrayListSlotPointer {
  constructor(public slotPtr: SlotPointer, public leafCount: number) {}

  withSlotPointer(slotPtr: SlotPointer): LinkedArrayListSlotPointer {
    return new LinkedArrayListSlotPointer(slotPtr, this.leafCount);
  }
}

// LinkedArrayListBlockInfo
export class LinkedArrayListBlockInfo {
  constructor(
    public block: LinkedArrayListSlot[],
    public i: number,
    public parentSlot: LinkedArrayListSlot
  ) {}
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

    switch (slotPtr.slot.tag) {
      case Tag.NONE: {
        const writer = db.core.writer();
        const arrayListStart = db.core.length();
        db.core.seek(arrayListStart);
        const arrayListPtr = arrayListStart + LinkedArrayListHeader.LENGTH;
        writer.write(new LinkedArrayListHeader(0, arrayListPtr, 0).toBytes());
        writer.write(new Uint8Array(LINKED_ARRAY_LIST_INDEX_BLOCK_SIZE));

        const nextSlotPtr = new SlotPointer(position, new Slot(arrayListStart, Tag.LINKED_ARRAY_LIST));
        db.core.seek(position);
        writer.write(nextSlotPtr.slot.toBytes());
        return db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);
      }
      case Tag.LINKED_ARRAY_LIST: {
        const reader = db.core.reader();
        const writer = db.core.writer();

        let arrayListStart = Number(slotPtr.slot.value);

        if (db.txStart !== null) {
          if (arrayListStart < db.txStart) {
            db.core.seek(arrayListStart);
            const headerBytes = new Uint8Array(LinkedArrayListHeader.LENGTH);
            reader.readFully(headerBytes);
            const header = LinkedArrayListHeader.fromBytes(headerBytes);
            db.core.seek(header.ptr);
            const arrayListIndexBlock = new Uint8Array(LINKED_ARRAY_LIST_INDEX_BLOCK_SIZE);
            reader.readFully(arrayListIndexBlock);

            arrayListStart = db.core.length();
            db.core.seek(arrayListStart);
            const nextArrayListPtr = arrayListStart + LinkedArrayListHeader.LENGTH;
            const newHeader = header.withPtr(nextArrayListPtr);
            writer.write(newHeader.toBytes());
            writer.write(arrayListIndexBlock);
          }
        } else if (db.header.tag === Tag.ARRAY_LIST) {
          throw new ExpectedTxStartException();
        }

        const nextSlotPtr = new SlotPointer(position, new Slot(arrayListStart, Tag.LINKED_ARRAY_LIST));
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

    let index = this.index;

    db.core.seek(Number(slotPtr.slot.value));
    const reader = db.core.reader();
    const headerBytes = new Uint8Array(LinkedArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = LinkedArrayListHeader.fromBytes(headerBytes);
    if (index >= header.size || index < -header.size) {
      throw new KeyNotFoundException();
    }

    const key = index < 0 ? header.size - Math.abs(index) : index;
    const finalSlotPtr = db.readLinkedArrayListSlot(header.ptr, key, header.shift, writeMode, isTopLevel);

    return db.readSlotPointer(writeMode, path, pathI + 1, finalSlotPtr.slotPtr);
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

    const reader = db.core.reader();
    const nextArrayListStart = Number(slotPtr.slot.value);

    db.core.seek(nextArrayListStart);
    const headerBytes = new Uint8Array(LinkedArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const origHeader = LinkedArrayListHeader.fromBytes(headerBytes);

    const appendResult = db.readLinkedArrayListSlotAppend(origHeader, writeMode, isTopLevel);
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, appendResult.slotPtr.slotPtr);

    const writer = db.core.writer();
    db.core.seek(nextArrayListStart);
    writer.write(appendResult.header.toBytes());

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

    const reader = db.core.reader();
    const nextArrayListStart = Number(slotPtr.slot.value);

    db.core.seek(nextArrayListStart);
    const headerBytes = new Uint8Array(LinkedArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const origHeader = LinkedArrayListHeader.fromBytes(headerBytes);

    const sliceHeader = db.readLinkedArrayListSlice(origHeader, this.offset, this.size);
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);

    const writer = db.core.writer();
    db.core.seek(nextArrayListStart);
    writer.write(sliceHeader.toBytes());

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

    const reader = db.core.reader();
    const nextArrayListStart = Number(slotPtr.slot.value);

    db.core.seek(nextArrayListStart);
    const headerBytesA = new Uint8Array(LinkedArrayListHeader.LENGTH);
    reader.readFully(headerBytesA);
    const headerA = LinkedArrayListHeader.fromBytes(headerBytesA);
    db.core.seek(Number(this.list.value));
    const headerBytesB = new Uint8Array(LinkedArrayListHeader.LENGTH);
    reader.readFully(headerBytesB);
    const headerB = LinkedArrayListHeader.fromBytes(headerBytesB);

    const concatHeader = db.readLinkedArrayListConcat(headerA, headerB);
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, slotPtr);

    const writer = db.core.writer();
    db.core.seek(nextArrayListStart);
    writer.write(concatHeader.toBytes());

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

    const reader = db.core.reader();
    const nextArrayListStart = Number(slotPtr.slot.value);

    db.core.seek(nextArrayListStart);
    const headerBytes = new Uint8Array(LinkedArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const origHeader = LinkedArrayListHeader.fromBytes(headerBytes);

    let index = this.index;
    if (index >= origHeader.size || index < -origHeader.size) {
      throw new KeyNotFoundException();
    }
    const key = index < 0 ? origHeader.size - Math.abs(index) : index;

    const headerA = db.readLinkedArrayListSlice(origHeader, 0, key);
    const headerB = db.readLinkedArrayListSlice(origHeader, key, origHeader.size - key);

    const appendResult = db.readLinkedArrayListSlotAppend(headerA, writeMode, isTopLevel);
    const concatHeader = db.readLinkedArrayListConcat(appendResult.header, headerB);

    const nextSlotPtr = db.readLinkedArrayListSlot(concatHeader.ptr, key, concatHeader.shift, WriteMode.READ_ONLY, isTopLevel);
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr.slotPtr);

    const writer = db.core.writer();
    db.core.seek(nextArrayListStart);
    writer.write(concatHeader.toBytes());

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

    const reader = db.core.reader();
    const nextArrayListStart = Number(slotPtr.slot.value);

    db.core.seek(nextArrayListStart);
    const headerBytes = new Uint8Array(LinkedArrayListHeader.LENGTH);
    reader.readFully(headerBytes);
    const origHeader = LinkedArrayListHeader.fromBytes(headerBytes);

    let index = this.index;
    if (index >= origHeader.size || index < -origHeader.size) {
      throw new KeyNotFoundException();
    }
    const key = index < 0 ? origHeader.size - Math.abs(index) : index;

    const headerA = db.readLinkedArrayListSlice(origHeader, 0, key);
    const headerB = db.readLinkedArrayListSlice(origHeader, key + 1, origHeader.size - (key + 1));
    const concatHeader = db.readLinkedArrayListConcat(headerA, headerB);

    const nextSlotPtr = new SlotPointer(concatHeader.ptr, new Slot(nextArrayListStart, Tag.LINKED_ARRAY_LIST));
    const finalSlotPtr = db.readSlotPointer(writeMode, path, pathI + 1, nextSlotPtr);

    const writer = db.core.writer();
    db.core.seek(nextArrayListStart);
    writer.write(concatHeader.toBytes());

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

// LinkedArrayListAppendResult
class LinkedArrayListAppendResult {
  constructor(public header: LinkedArrayListHeader, public slotPtr: LinkedArrayListSlotPointer) {}
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

  // LinkedArrayList methods
  readLinkedArrayListSlotAppend(
    header: LinkedArrayListHeader,
    writeMode: WriteMode,
    isTopLevel: boolean
  ): LinkedArrayListAppendResult {
    const writer = this.core.writer();

    let ptr = header.ptr;
    const key = header.size;
    let shift = header.shift;

    let slotPtr: LinkedArrayListSlotPointer;
    try {
      slotPtr = this.readLinkedArrayListSlot(ptr, key, shift, writeMode, isTopLevel);
    } catch (e) {
      if (e instanceof NoAvailableSlotsException) {
        const nextPtr = this.core.length();
        this.core.seek(nextPtr);
        writer.write(new Uint8Array(LINKED_ARRAY_LIST_INDEX_BLOCK_SIZE));
        this.core.seek(nextPtr);
        writer.write(new LinkedArrayListSlot(header.size, new Slot(ptr, Tag.INDEX, true)).toBytes());
        ptr = nextPtr;
        shift += 1;
        slotPtr = this.readLinkedArrayListSlot(ptr, key, shift, writeMode, isTopLevel);
      } else {
        throw e;
      }
    }

    const newSlot = new Slot(0, Tag.NONE, true);
    slotPtr = slotPtr.withSlotPointer(slotPtr.slotPtr.withSlot(newSlot));
    if (slotPtr.slotPtr.position === null) throw new CursorNotWriteableException();
    const position = slotPtr.slotPtr.position;
    this.core.seek(position);
    writer.write(new LinkedArrayListSlot(0, newSlot).toBytes());
    if (header.size < SLOT_COUNT && shift > 0) {
      throw new MustSetNewSlotsToFullException();
    }

    return new LinkedArrayListAppendResult(
      new LinkedArrayListHeader(shift, ptr, header.size + 1),
      slotPtr
    );
  }

  private static blockLeafCount(block: LinkedArrayListSlot[], shift: number, i: number): number {
    let n = 0;
    if (shift === 0) {
      for (let blockI = 0; blockI < block.length; blockI++) {
        const blockSlot = block[blockI];
        if (!blockSlot.slot.empty() || blockI === i) {
          n += 1;
        }
      }
    } else {
      for (const blockSlot of block) {
        n += blockSlot.size;
      }
    }
    return n;
  }

  private static slotLeafCount(slot: LinkedArrayListSlot, shift: number): number {
    if (shift === 0) {
      if (slot.slot.empty()) {
        return 0;
      } else {
        return 1;
      }
    } else {
      return slot.size;
    }
  }

  private static keyAndIndexForLinkedArrayList(
    slotBlock: LinkedArrayListSlot[],
    key: number,
    shift: number
  ): { key: number; index: number } | null {
    let nextKey = key;
    let i = 0;
    const maxLeafCount = shift === 0 ? 1 : Math.pow(SLOT_COUNT, shift);
    while (true) {
      const slotLeafCount = Database.slotLeafCount(slotBlock[i], shift);
      if (nextKey === slotLeafCount) {
        if (slotLeafCount === maxLeafCount || slotBlock[i].slot.full) {
          if (i < SLOT_COUNT - 1) {
            nextKey -= slotLeafCount;
            i += 1;
          } else {
            return null;
          }
        }
        break;
      } else if (nextKey < slotLeafCount) {
        break;
      } else if (i < SLOT_COUNT - 1) {
        nextKey -= slotLeafCount;
        i += 1;
      } else {
        return null;
      }
    }
    return { key: nextKey, index: i };
  }

  readLinkedArrayListSlot(
    indexPos: number,
    key: number,
    shift: number,
    writeMode: WriteMode,
    isTopLevel: boolean
  ): LinkedArrayListSlotPointer {
    if (shift >= MAX_BRANCH_LENGTH) throw new MaxShiftExceededException();

    const reader = this.core.reader();
    const writer = this.core.writer();

    const slotBlock: LinkedArrayListSlot[] = new Array(SLOT_COUNT);
    this.core.seek(indexPos);
    const indexBlock = new Uint8Array(LINKED_ARRAY_LIST_INDEX_BLOCK_SIZE);
    reader.readFully(indexBlock);

    for (let i = 0; i < SLOT_COUNT; i++) {
      const slotBytes = indexBlock.slice(i * LinkedArrayListSlot.LENGTH, (i + 1) * LinkedArrayListSlot.LENGTH);
      slotBlock[i] = LinkedArrayListSlot.fromBytes(slotBytes);
    }

    const keyAndIndex = Database.keyAndIndexForLinkedArrayList(slotBlock, key, shift);
    if (keyAndIndex === null) throw new NoAvailableSlotsException();
    const nextKey = keyAndIndex.key;
    const i = keyAndIndex.index;
    const slot = slotBlock[i];
    const slotPos = indexPos + LinkedArrayListSlot.LENGTH * i;

    if (shift === 0) {
      const leafCount = Database.blockLeafCount(slotBlock, shift, i);
      return new LinkedArrayListSlotPointer(new SlotPointer(slotPos, slot.slot), leafCount);
    }

    const ptr = Number(slot.slot.value);

    switch (slot.slot.tag) {
      case Tag.NONE: {
        switch (writeMode) {
          case WriteMode.READ_ONLY:
            throw new KeyNotFoundException();
          case WriteMode.READ_WRITE: {
            const nextIndexPos = this.core.length();
            this.core.seek(nextIndexPos);
            writer.write(new Uint8Array(LINKED_ARRAY_LIST_INDEX_BLOCK_SIZE));

            const nextSlotPtr = this.readLinkedArrayListSlot(nextIndexPos, nextKey, shift - 1, writeMode, isTopLevel);
            slotBlock[i] = slotBlock[i].withSize(nextSlotPtr.leafCount);
            const leafCount = Database.blockLeafCount(slotBlock, shift, i);
            this.core.seek(slotPos);
            writer.write(new LinkedArrayListSlot(nextSlotPtr.leafCount, new Slot(nextIndexPos, Tag.INDEX)).toBytes());
            return new LinkedArrayListSlotPointer(nextSlotPtr.slotPtr, leafCount);
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
              const indexBlockCopy = new Uint8Array(LINKED_ARRAY_LIST_INDEX_BLOCK_SIZE);
              reader.readFully(indexBlockCopy);

              nextPtr = this.core.length();
              this.core.seek(nextPtr);
              writer.write(indexBlockCopy);
            }
          } else if (this.header.tag === Tag.ARRAY_LIST) {
            throw new ExpectedTxStartException();
          }
        }

        const nextSlotPtr = this.readLinkedArrayListSlot(nextPtr, nextKey, shift - 1, writeMode, isTopLevel);

        slotBlock[i] = slotBlock[i].withSize(nextSlotPtr.leafCount);
        const leafCount = Database.blockLeafCount(slotBlock, shift, i);

        if (writeMode === WriteMode.READ_WRITE && !isTopLevel) {
          this.core.seek(slotPos);
          writer.write(new LinkedArrayListSlot(nextSlotPtr.leafCount, new Slot(nextPtr, Tag.INDEX)).toBytes());
        }

        return new LinkedArrayListSlotPointer(nextSlotPtr.slotPtr, leafCount);
      }
      default:
        throw new UnexpectedTagException();
    }
  }

  readLinkedArrayListBlocks(
    indexPos: number,
    key: number,
    shift: number,
    blocks: LinkedArrayListBlockInfo[]
  ): void {
    const reader = this.core.reader();

    const slotBlock: LinkedArrayListSlot[] = new Array(SLOT_COUNT);
    this.core.seek(indexPos);
    const indexBlock = new Uint8Array(LINKED_ARRAY_LIST_INDEX_BLOCK_SIZE);
    reader.readFully(indexBlock);

    for (let i = 0; i < SLOT_COUNT; i++) {
      const slotBytes = indexBlock.slice(i * LinkedArrayListSlot.LENGTH, (i + 1) * LinkedArrayListSlot.LENGTH);
      slotBlock[i] = LinkedArrayListSlot.fromBytes(slotBytes);
    }

    const keyAndIndex = Database.keyAndIndexForLinkedArrayList(slotBlock, key, shift);
    if (keyAndIndex === null) throw new NoAvailableSlotsException();
    const nextKey = keyAndIndex.key;
    const i = keyAndIndex.index;
    const leafCount = Database.blockLeafCount(slotBlock, shift, i);

    blocks.push(new LinkedArrayListBlockInfo(slotBlock, i, new LinkedArrayListSlot(leafCount, new Slot(indexPos, Tag.INDEX))));

    if (shift === 0) {
      return;
    }

    const slot = slotBlock[i];
    switch (slot.slot.tag) {
      case Tag.NONE:
        throw new EmptySlotException();
      case Tag.INDEX:
        this.readLinkedArrayListBlocks(Number(slot.slot.value), nextKey, shift - 1, blocks);
        break;
      default:
        throw new UnexpectedTagException();
    }
  }

  private populateArray(arr: LinkedArrayListSlot[]): void {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = new LinkedArrayListSlot(0, new Slot());
    }
  }

  readLinkedArrayListSlice(
    header: LinkedArrayListHeader,
    offset: number,
    size: number
  ): LinkedArrayListHeader {
    const writer = this.core.writer();

    if (offset + size > header.size) {
      throw new KeyNotFoundException();
    }

    const leftBlocks: LinkedArrayListBlockInfo[] = [];
    this.readLinkedArrayListBlocks(header.ptr, offset, header.shift, leftBlocks);

    const rightBlocks: LinkedArrayListBlockInfo[] = [];
    const rightKey = offset + size === 0 ? 0 : offset + size - 1;
    this.readLinkedArrayListBlocks(header.ptr, rightKey, header.shift, rightBlocks);

    const blockCount = leftBlocks.length;
    let nextSlots: (LinkedArrayListSlot | null)[] = [null, null];
    let nextShift = 0;

    for (let i = 0; i < blockCount; i++) {
      const isLeafNode = nextSlots[0] === null;

      const leftBlock = leftBlocks[blockCount - i - 1];
      const rightBlock = rightBlocks[blockCount - i - 1];
      const origBlockInfos = [leftBlock, rightBlock];
      let nextBlocks: (LinkedArrayListSlot[] | null)[] = [null, null];

      if (leftBlock.parentSlot.slot.value === rightBlock.parentSlot.slot.value) {
        let slotI = 0;
        const newRootBlock: LinkedArrayListSlot[] = new Array(SLOT_COUNT);
        this.populateArray(newRootBlock);

        if (size > 0) {
          if (nextSlots[0] !== null) {
            newRootBlock[slotI] = nextSlots[0];
          } else {
            newRootBlock[slotI] = leftBlock.block[leftBlock.i];
          }
          slotI += 1;
        }
        if (size > 1) {
          for (let j = leftBlock.i + 1; j < rightBlock.i; j++) {
            const middleSlot = leftBlock.block[j];
            newRootBlock[slotI] = middleSlot;
            slotI += 1;
          }

          if (nextSlots[1] !== null) {
            newRootBlock[slotI] = nextSlots[1];
          } else {
            newRootBlock[slotI] = leftBlock.block[rightBlock.i];
          }
        }
        nextBlocks[0] = newRootBlock;
      } else {
        let slotI = 0;
        const newLeftBlock: LinkedArrayListSlot[] = new Array(SLOT_COUNT);
        this.populateArray(newLeftBlock);

        if (nextSlots[0] !== null) {
          newLeftBlock[slotI] = nextSlots[0];
        } else {
          newLeftBlock[slotI] = leftBlock.block[leftBlock.i];
        }
        slotI += 1;
        for (let j = leftBlock.i + 1; j < leftBlock.block.length; j++) {
          const nextSlot = leftBlock.block[j];
          newLeftBlock[slotI] = nextSlot;
          slotI += 1;
        }
        nextBlocks[0] = newLeftBlock;

        slotI = 0;
        const newRightBlock: LinkedArrayListSlot[] = new Array(SLOT_COUNT);
        this.populateArray(newRightBlock);
        for (let j = 0; j < rightBlock.i; j++) {
          const firstSlot = rightBlock.block[j];
          newRightBlock[slotI] = firstSlot;
          slotI += 1;
        }
        if (nextSlots[1] !== null) {
          newRightBlock[slotI] = nextSlots[1];
        } else {
          newRightBlock[slotI] = rightBlock.block[rightBlock.i];
        }
        nextBlocks[1] = newRightBlock;

        nextShift += 1;
      }

      nextSlots = [null, null];

      this.core.seek(this.core.length());
      for (let j = 0; j < 2; j++) {
        const blockMaybe = nextBlocks[j];
        const origBlockInfo = origBlockInfos[j];

        if (blockMaybe !== null) {
          let eql = true;
          for (let k = 0; k < blockMaybe.length; k++) {
            const blockSlot = blockMaybe[k];
            const origSlot = origBlockInfo.block[k];
            if (!blockSlot.slot.equals(origSlot.slot)) {
              eql = false;
              break;
            }
          }

          if (eql) {
            nextSlots[j] = origBlockInfo.parentSlot;
          } else {
            const nextPtr = this.core.position();
            let leafCount = 0;
            for (let k = 0; k < blockMaybe.length; k++) {
              const blockSlot = blockMaybe[k];
              writer.write(blockSlot.toBytes());
              if (isLeafNode) {
                if (!blockSlot.slot.empty()) {
                  leafCount += 1;
                }
              } else {
                leafCount += blockSlot.size;
              }
            }
            nextSlots[j] = new LinkedArrayListSlot(
              leafCount,
              j === 0 ? new Slot(nextPtr, Tag.INDEX, true) : new Slot(nextPtr, Tag.INDEX)
            );
          }
        }
      }

      if (nextSlots[0] !== null && nextSlots[1] === null) {
        break;
      }
    }

    const rootSlot = nextSlots[0];
    if (rootSlot === null) throw new ExpectedRootNodeException();

    return new LinkedArrayListHeader(nextShift, Number(rootSlot.slot.value), size);
  }

  readLinkedArrayListConcat(
    headerA: LinkedArrayListHeader,
    headerB: LinkedArrayListHeader
  ): LinkedArrayListHeader {
    const writer = this.core.writer();

    const blocksA: LinkedArrayListBlockInfo[] = [];
    const keyA = headerA.size === 0 ? 0 : headerA.size - 1;
    this.readLinkedArrayListBlocks(headerA.ptr, keyA, headerA.shift, blocksA);

    const blocksB: LinkedArrayListBlockInfo[] = [];
    this.readLinkedArrayListBlocks(headerB.ptr, 0, headerB.shift, blocksB);

    let nextSlots: (LinkedArrayListSlot | null)[] = [null, null];
    let nextShift = 0;

    for (let i = 0; i < Math.max(blocksA.length, blocksB.length); i++) {
      const blockInfos: (LinkedArrayListBlockInfo | null)[] = [
        i < blocksA.length ? blocksA[blocksA.length - 1 - i] : null,
        i < blocksB.length ? blocksB[blocksB.length - 1 - i] : null,
      ];
      let nextBlocks: (LinkedArrayListSlot[] | null)[] = [null, null];
      const isLeafNode = nextSlots[0] === null;

      if (!isLeafNode) {
        nextShift += 1;
      }

      for (let j = 0; j < 2; j++) {
        const blockInfoMaybe = blockInfos[j];
        if (blockInfoMaybe !== null) {
          const block: LinkedArrayListSlot[] = new Array(SLOT_COUNT);
          this.populateArray(block);
          let targetI = 0;
          for (let sourceI = 0; sourceI < blockInfoMaybe.block.length; sourceI++) {
            const blockSlot = blockInfoMaybe.block[sourceI];
            if (!isLeafNode && blockInfoMaybe.i === sourceI) {
              continue;
            } else if (blockSlot.slot.empty()) {
              break;
            }
            block[targetI] = blockSlot;
            targetI += 1;
          }

          if (targetI === 0) {
            continue;
          }

          nextBlocks[j] = block;
        }
      }

      const slotsToWrite: LinkedArrayListSlot[] = new Array(SLOT_COUNT * 2);
      this.populateArray(slotsToWrite);
      let slotI = 0;

      if (nextBlocks[0] !== null) {
        for (const blockSlot of nextBlocks[0]) {
          if (blockSlot.slot.empty()) {
            break;
          }
          slotsToWrite[slotI] = blockSlot;
          slotI += 1;
        }
      }

      for (const slotMaybe of nextSlots) {
        if (slotMaybe !== null) {
          slotsToWrite[slotI] = slotMaybe;
          slotI += 1;
        }
      }

      if (nextBlocks[1] !== null) {
        for (const blockSlot of nextBlocks[1]) {
          if (blockSlot.slot.empty()) {
            break;
          }
          slotsToWrite[slotI] = blockSlot;
          slotI += 1;
        }
      }

      nextSlots = [null, null];

      const blocks: LinkedArrayListSlot[][] = [new Array(SLOT_COUNT), new Array(SLOT_COUNT)];
      this.populateArray(blocks[0]);
      this.populateArray(blocks[1]);

      if (slotI > SLOT_COUNT) {
        if (headerA.size < headerB.size) {
          for (let j = 0; j < slotI - SLOT_COUNT; j++) {
            blocks[0][j] = slotsToWrite[j];
          }
          for (let j = 0; j < SLOT_COUNT; j++) {
            blocks[1][j] = slotsToWrite[j + (slotI - SLOT_COUNT)];
          }
        } else {
          for (let j = 0; j < SLOT_COUNT; j++) {
            blocks[0][j] = slotsToWrite[j];
          }
          for (let j = 0; j < slotI - SLOT_COUNT; j++) {
            blocks[1][j] = slotsToWrite[j + SLOT_COUNT];
          }
        }
      } else {
        for (let j = 0; j < slotI; j++) {
          blocks[0][j] = slotsToWrite[j];
        }
      }

      this.core.seek(this.core.length());
      for (let blockI = 0; blockI < blocks.length; blockI++) {
        const block = blocks[blockI];

        if (block[0].slot.empty()) {
          break;
        }

        const nextPtr = this.core.position();
        let leafCount = 0;
        for (const blockSlot of block) {
          writer.write(blockSlot.toBytes());
          if (isLeafNode) {
            if (!blockSlot.slot.empty()) {
              leafCount += 1;
            }
          } else {
            leafCount += blockSlot.size;
          }
        }

        nextSlots[blockI] = new LinkedArrayListSlot(leafCount, new Slot(nextPtr, Tag.INDEX, true));
      }
    }

    let rootPtr: number;
    if (nextSlots[0] !== null) {
      if (nextSlots[1] !== null) {
        const block: LinkedArrayListSlot[] = new Array(SLOT_COUNT);
        this.populateArray(block);
        block[0] = nextSlots[0];
        block[1] = nextSlots[1];

        const newPtr = this.core.length();
        for (const blockSlot of block) {
          writer.write(blockSlot.toBytes());
        }

        if (nextShift === MAX_BRANCH_LENGTH) throw new MaxShiftExceededException();
        nextShift += 1;

        rootPtr = newPtr;
      } else {
        rootPtr = Number(nextSlots[0].slot.value);
      }
    } else {
      rootPtr = headerA.ptr;
    }

    return new LinkedArrayListHeader(nextShift, rootPtr, headerA.size + headerB.size);
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
      const newOffset = remapLinkedArrayList(sourceCore, targetCore, hashSize, offsetMap, slot);
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

function remapLinkedArrayList(
  sourceCore: Core,
  targetCore: Core,
  hashSize: number,
  offsetMap: Map<number, number>,
  slot: Slot
): number {
  // read LinkedArrayListHeader (17 bytes)
  sourceCore.seek(Number(slot.value));
  const sourceReader = sourceCore.reader();
  const headerBytes = new Uint8Array(LinkedArrayListHeader.LENGTH);
  sourceReader.readFully(headerBytes);
  const header = LinkedArrayListHeader.fromBytes(headerBytes);

  // remap root block
  const remappedPtr = remapLinkedArrayListBlock(sourceCore, targetCore, hashSize, offsetMap, header.ptr);

  // write new header
  const newOffset = targetCore.length();
  targetCore.seek(newOffset);
  const targetWriter = targetCore.writer();
  targetWriter.write(new LinkedArrayListHeader(header.shift, remappedPtr, header.size).toBytes());

  return newOffset;
}

function remapLinkedArrayListBlock(
  sourceCore: Core,
  targetCore: Core,
  hashSize: number,
  offsetMap: Map<number, number>,
  blockOffset: number
): number {
  // dedup check
  const mapped = offsetMap.get(blockOffset);
  if (mapped !== undefined) return mapped;

  // read 272-byte block (16 x LinkedArrayListSlot of 17 bytes)
  sourceCore.seek(blockOffset);
  const sourceReader = sourceCore.reader();
  const blockBytes = new Uint8Array(LINKED_ARRAY_LIST_INDEX_BLOCK_SIZE);
  sourceReader.readFully(blockBytes);

  // parse slots
  const slots: LinkedArrayListSlot[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const slotBytes = blockBytes.slice(i * LinkedArrayListSlot.LENGTH, (i + 1) * LinkedArrayListSlot.LENGTH);
    slots.push(LinkedArrayListSlot.fromBytes(slotBytes));
  }

  // remap each slot
  const remappedSlots: LinkedArrayListSlot[] = [];
  for (const s of slots) {
    if (s.slot.tag === Tag.INDEX) {
      // index slots point to other 272-byte blocks, recurse on ourselves
      const remappedPtr = remapLinkedArrayListBlock(sourceCore, targetCore, hashSize, offsetMap, Number(s.slot.value));
      remappedSlots.push(new LinkedArrayListSlot(s.size, new Slot(remappedPtr, Tag.INDEX, s.slot.full)));
    } else if (s.slot.empty()) {
      remappedSlots.push(s);
    } else {
      // leaf slot - remap via remapSlot
      const remapped = remapSlot(sourceCore, targetCore, hashSize, offsetMap, s.slot);
      remappedSlots.push(new LinkedArrayListSlot(s.size, remapped));
    }
  }

  // write remapped block to target
  const newOffset = targetCore.length();
  targetCore.seek(newOffset);
  const targetWriter = targetCore.writer();
  for (const s of remappedSlots) {
    targetWriter.write(s.toBytes());
  }

  offsetMap.set(blockOffset, newOffset);
  return newOffset;
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

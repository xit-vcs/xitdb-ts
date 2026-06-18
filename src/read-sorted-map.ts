import { Tag } from './tag.js';
import { Slot } from './slot.js';
import type { Slotted } from './slotted.js';
import { ReadCursor, CursorIterator, KeyValuePairCursor } from './read-cursor.js';
import {
  SortedMapGet,
  SortedMapGetValue,
  SortedMapGetKVPair,
  SortedMapGetIndex,
  BTreeHeader,
} from './database.js';
import { UnexpectedTagException } from './exceptions.js';
import { Bytes } from './writeable-data.js';

export class ReadSortedMap implements Slotted {
  public cursor!: ReadCursor;

  constructor();
  constructor(cursor: ReadCursor);
  constructor(cursor?: ReadCursor) {
    if (cursor) {
      switch (cursor.slotPtr.slot.tag) {
        case Tag.NONE:
        case Tag.SORTED_MAP:
        case Tag.SORTED_SET:
          this.cursor = cursor;
          break;
        default:
          throw new UnexpectedTagException();
      }
    }
  }

  slot(): Slot {
    return this.cursor.slot();
  }

  count(): number {
    return this.cursor.count();
  }

  iterator(): CursorIterator {
    return this.cursor.iterator();
  }

  *[Symbol.iterator](): Iterator<ReadCursor> {
    yield* this.cursor;
  }

  // iterate in key order starting at the first entry with key >= startKey
  iteratorFrom(key: string | Bytes | Uint8Array): CursorIterator {
    return CursorIterator.initSortedFromKey(this.cursor, this.resolveKey(key));
  }

  // iterate in key order starting at the entry with rank startIndex
  iteratorFromIndex(startIndex: number): CursorIterator {
    return CursorIterator.initSortedFromIndex(this.cursor, startIndex);
  }

  getCursor(key: string | Bytes | Uint8Array): ReadCursor | null {
    return this.cursor.readPath([new SortedMapGet(new SortedMapGetValue(this.resolveKey(key)))]);
  }

  getSlot(key: string | Bytes | Uint8Array): Slot | null {
    return this.cursor.readPathSlot([new SortedMapGet(new SortedMapGetValue(this.resolveKey(key)))]);
  }

  getKeyValuePair(key: string | Bytes | Uint8Array): KeyValuePairCursor | null {
    const cursor = this.cursor.readPath([new SortedMapGet(new SortedMapGetKVPair(this.resolveKey(key)))]);
    return cursor === null ? null : cursor.readKeyValuePair();
  }

  // the key/value pair at the given rank (negative counts from the end)
  getIndexKeyValuePair(index: number): KeyValuePairCursor | null {
    const cursor = this.cursor.readPath([new SortedMapGetIndex(index)]);
    return cursor === null ? null : cursor.readKeyValuePair();
  }

  // number of keys strictly less than key (the inverse of getIndexKeyValuePair)
  rank(key: string | Bytes | Uint8Array): number {
    if (this.cursor.slotPtr.slot.tag === Tag.NONE) return 0;
    this.cursor.db.core.seek(Number(this.cursor.slotPtr.slot.value));
    const reader = this.cursor.db.core.reader();
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);
    return this.cursor.db.sortedRank(header.rootPtr, this.resolveKey(key));
  }

  // sorted-map keys are byte strings, not hashes
  protected resolveKey(key: string | Bytes | Uint8Array): Uint8Array {
    if (key instanceof Uint8Array) return key;
    if (typeof key === 'string') return new TextEncoder().encode(key);
    return key.value;
  }
}

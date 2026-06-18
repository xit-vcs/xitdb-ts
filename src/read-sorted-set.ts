import { Tag } from './tag.js';
import { Slot } from './slot.js';
import type { Slotted } from './slotted.js';
import { ReadCursor, CursorIterator, KeyValuePairCursor } from './read-cursor.js';
import { SortedMapGet, SortedMapGetKey, SortedMapGetIndex, BTreeHeader } from './database.js';
import { UnexpectedTagException } from './exceptions.js';
import { Bytes } from './writeable-data.js';

// a sorted set of byte-string keys (a SortedMap with no values).
export class ReadSortedSet implements Slotted {
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

  iteratorFrom(key: string | Bytes | Uint8Array): CursorIterator {
    return CursorIterator.initSortedFromKey(this.cursor, this.resolveKey(key));
  }

  iteratorFromIndex(startIndex: number): CursorIterator {
    return CursorIterator.initSortedFromIndex(this.cursor, startIndex);
  }

  // the key/value pair at the given rank (negative counts from the end)
  getIndexKeyValuePair(index: number): KeyValuePairCursor | null {
    const cursor = this.cursor.readPath([new SortedMapGetIndex(index)]);
    return cursor === null ? null : cursor.readKeyValuePair();
  }

  contains(key: string | Bytes | Uint8Array): boolean {
    return this.cursor.readPath([new SortedMapGet(new SortedMapGetKey(this.resolveKey(key)))]) !== null;
  }

  // number of keys strictly less than key
  rank(key: string | Bytes | Uint8Array): number {
    if (this.cursor.slotPtr.slot.tag === Tag.NONE) return 0;
    this.cursor.db.core.seek(Number(this.cursor.slotPtr.slot.value));
    const reader = this.cursor.db.core.reader();
    const headerBytes = new Uint8Array(BTreeHeader.LENGTH);
    reader.readFully(headerBytes);
    const header = BTreeHeader.fromBytes(headerBytes);
    return this.cursor.db.sortedRank(header.rootPtr, this.resolveKey(key));
  }

  // sorted-set keys are byte strings, not hashes
  protected resolveKey(key: string | Bytes | Uint8Array): Uint8Array {
    if (key instanceof Uint8Array) return key;
    if (typeof key === 'string') return new TextEncoder().encode(key);
    return key.value;
  }
}

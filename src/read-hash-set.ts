import { Tag } from './tag.js';
import { Slot } from './slot.js';
import type { Slotted } from './slotted.js';
import { ReadCursor, CursorIterator } from './read-cursor.js';
import { HashMapGet, HashMapGetKey } from './database.js';
import { UnexpectedTagException } from './exceptions.js';
import { Bytes } from './writeable-data.js';

export class ReadHashSet implements Slotted {
  public cursor!: ReadCursor;

  constructor();
  constructor(cursor: ReadCursor);
  constructor(cursor?: ReadCursor) {
    if (cursor) {
      switch (cursor.slotPtr.slot.tag) {
        case Tag.NONE:
        case Tag.HASH_MAP:
        case Tag.HASH_SET:
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

  iterator(): CursorIterator {
    return this.cursor.iterator();
  }

  *[Symbol.iterator](): Iterator<ReadCursor> {
    yield* this.cursor;
  }

  // getCursor overloads
  getCursor(key: string): ReadCursor | null;
  getCursor(key: Bytes): ReadCursor | null;
  getCursor(hash: Uint8Array): ReadCursor | null;
  getCursor(key: string | Bytes | Uint8Array): ReadCursor | null {
    const hash = this.resolveHash(key);
    return this.cursor.readPath([new HashMapGet(new HashMapGetKey(hash))]);
  }

  // getSlot overloads
  getSlot(key: string): Slot | null;
  getSlot(key: Bytes): Slot | null;
  getSlot(hash: Uint8Array): Slot | null;
  getSlot(key: string | Bytes | Uint8Array): Slot | null {
    const hash = this.resolveHash(key);
    return this.cursor.readPathSlot([new HashMapGet(new HashMapGetKey(hash))]);
  }

  // Helper to resolve key to hash
  protected resolveHash(key: string | Bytes | Uint8Array): Uint8Array {
    if (key instanceof Uint8Array) {
      return key;
    } else if (typeof key === 'string') {
      return this.cursor.db.hasher.digest(new TextEncoder().encode(key));
    } else {
      return this.cursor.db.hasher.digest(key.value);
    }
  }
}

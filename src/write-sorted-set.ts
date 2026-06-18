import { ReadSortedSet } from './read-sorted-set.js';
import { WriteCursor, WriteCursorIterator } from './write-cursor.js';
import { SortedMapInit, SortedMapGet, SortedMapGetKey, SortedMapRemove } from './database.js';
import { Bytes } from './writeable-data.js';
import { KeyNotFoundException } from './exceptions.js';

export class WriteSortedSet extends ReadSortedSet {
  constructor(cursor: WriteCursor) {
    super();
    this.cursor = cursor.writePath([new SortedMapInit(true)]);
  }

  override iterator(): WriteCursorIterator {
    return (this.cursor as WriteCursor).iterator();
  }

  override *[Symbol.iterator](): Iterator<WriteCursor> {
    yield* this.cursor as WriteCursor;
  }

  put(key: string | Bytes | Uint8Array): void {
    (this.cursor as WriteCursor).writePath([new SortedMapGet(new SortedMapGetKey(this.resolveKey(key)))]);
  }

  remove(key: string | Bytes | Uint8Array): boolean {
    try {
      (this.cursor as WriteCursor).writePath([new SortedMapRemove(this.resolveKey(key))]);
    } catch (e) {
      if (e instanceof KeyNotFoundException) return false;
      throw e;
    }
    return true;
  }
}

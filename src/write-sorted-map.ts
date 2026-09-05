import { ReadSortedMap } from './read-sorted-map.js';
import { WriteCursor, WriteCursorIterator } from './write-cursor.js';
import {
  SortedMapInit,
  SortedMapGet,
  SortedMapGetValue,
  SortedMapRemove,
  WriteData,
} from './database.js';
import type { WriteableData } from './writeable-data.js';
import { Bytes } from './writeable-data.js';
import { KeyNotFoundException } from './exceptions.js';

export class WriteSortedMap extends ReadSortedMap {
  constructor(cursor: WriteCursor) {
    super();
    this.cursor = cursor.writePath([new SortedMapInit(false)]);
  }

  override iterator(): WriteCursorIterator {
    return (this.cursor as WriteCursor).iterator();
  }

  override iteratorFrom(key: string | Bytes | Uint8Array): WriteCursorIterator {
    return WriteCursorIterator.from(super.iteratorFrom(key));
  }

  override iteratorFromIndex(startIndex: number): WriteCursorIterator {
    return WriteCursorIterator.from(super.iteratorFromIndex(startIndex));
  }

  put(key: string | Bytes | Uint8Array, data: WriteableData): void {
    (this.cursor as WriteCursor).writePath([
      new SortedMapGet(new SortedMapGetValue(this.resolveKey(key))),
      new WriteData(data),
    ]);
  }

  putCursor(key: string | Bytes | Uint8Array): WriteCursor {
    return (this.cursor as WriteCursor).writePath([
      new SortedMapGet(new SortedMapGetValue(this.resolveKey(key))),
    ]);
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

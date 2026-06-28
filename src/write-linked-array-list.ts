import { Slot } from './slot.js';
import { ReadLinkedArrayList } from './read-linked-array-list.js';
import { WriteCursor, WriteCursorIterator } from './write-cursor.js';
import {
  LinkedArrayListInit,
  LinkedArrayListGet,
  LinkedArrayListAppend,
  LinkedArrayListSlice,
  LinkedArrayListConcat,
  LinkedArrayListInsert,
  LinkedArrayListRemove,
  WriteData,
} from './database.js';
import type { WriteableData } from './writeable-data.js';

export class WriteLinkedArrayList extends ReadLinkedArrayList {
  constructor(cursor: WriteCursor) {
    super();
    this.cursor = cursor.writePath([new LinkedArrayListInit()]);
  }

  override iterator(): WriteCursorIterator {
    return (this.cursor as WriteCursor).iterator();
  }

  override iteratorFrom(index: number): WriteCursorIterator {
    return WriteCursorIterator.from(super.iteratorFrom(index));
  }

  override *[Symbol.iterator](): Iterator<WriteCursor> {
    yield* this.cursor as WriteCursor;
  }

  put(index: number, data: WriteableData): void {
    (this.cursor as WriteCursor).writePath([
      new LinkedArrayListGet(index),
      new WriteData(data),
    ]);
  }

  putCursor(index: number): WriteCursor {
    return (this.cursor as WriteCursor).writePath([new LinkedArrayListGet(index)]);
  }

  append(data: WriteableData): void {
    (this.cursor as WriteCursor).writePath([
      new LinkedArrayListAppend(),
      new WriteData(data),
    ]);
  }

  appendCursor(): WriteCursor {
    return (this.cursor as WriteCursor).writePath([new LinkedArrayListAppend()]);
  }

  slice(offset: number, size: number): void {
    (this.cursor as WriteCursor).writePath([
      new LinkedArrayListSlice(offset, size),
    ]);
  }

  concat(list: Slot): void {
    (this.cursor as WriteCursor).writePath([new LinkedArrayListConcat(list)]);
  }

  insert(index: number, data: WriteableData): void {
    (this.cursor as WriteCursor).writePath([
      new LinkedArrayListInsert(index),
      new WriteData(data),
    ]);
  }

  insertCursor(index: number): WriteCursor {
    return (this.cursor as WriteCursor).writePath([new LinkedArrayListInsert(index)]);
  }

  remove(index: number): void {
    (this.cursor as WriteCursor).writePath([new LinkedArrayListRemove(index)]);
  }
}

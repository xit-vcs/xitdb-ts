import { Slot } from './slot';
import { ReadLinkedArrayList } from './read-linked-array-list';
import { WriteCursor, WriteCursorIterator } from './write-cursor';
import {
  LinkedArrayListInit,
  LinkedArrayListGet,
  LinkedArrayListAppend,
  LinkedArrayListSlice,
  LinkedArrayListConcat,
  LinkedArrayListInsert,
  LinkedArrayListRemove,
  WriteData,
} from './database';
import type { WriteableData } from './writeable-data';

export class WriteLinkedArrayList extends ReadLinkedArrayList {
  constructor(cursor: WriteCursor) {
    super();
    this.cursor = cursor.writePath([new LinkedArrayListInit()]);
  }

  override iterator(): WriteCursorIterator {
    return (this.cursor as WriteCursor).iterator();
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

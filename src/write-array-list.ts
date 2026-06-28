import { ReadArrayList } from './read-array-list.js';
import { WriteCursor, WriteCursorIterator } from './write-cursor.js';
import {
  ArrayListInit,
  ArrayListGet,
  ArrayListAppend,
  ArrayListSlice,
  WriteData,
  Context,
  type ContextFunction,
} from './database.js';
import type { WriteableData } from './writeable-data.js';

export class WriteArrayList extends ReadArrayList {
  constructor(cursor: WriteCursor) {
    super();
    this.cursor = cursor.writePath([new ArrayListInit()]);
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
      new ArrayListGet(index),
      new WriteData(data),
    ]);
  }

  putCursor(index: number): WriteCursor {
    return (this.cursor as WriteCursor).writePath([new ArrayListGet(index)]);
  }

  append(data: WriteableData): void {
    (this.cursor as WriteCursor).writePath([
      new ArrayListAppend(),
      new WriteData(data),
    ]);
  }

  appendCursor(): WriteCursor {
    return (this.cursor as WriteCursor).writePath([new ArrayListAppend()]);
  }

  appendContext(data: WriteableData | null, fn: ContextFunction): void {
    (this.cursor as WriteCursor).writePath([
      new ArrayListAppend(),
      new WriteData(data),
      new Context(fn),
    ]);
  }

  slice(size: number): void {
    (this.cursor as WriteCursor).writePath([new ArrayListSlice(size)]);
  }
}

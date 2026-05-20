import { Tag } from './tag.js';
import { Slot } from './slot.js';
import type { Slotted } from './slotted.js';
import { ReadCursor, CursorIterator } from './read-cursor.js';
import { ArrayListGet } from './database.js';
import { UnexpectedTagException } from './exceptions.js';

export class ReadArrayList implements Slotted {
  public cursor!: ReadCursor;

  constructor();
  constructor(cursor: ReadCursor);
  constructor(cursor?: ReadCursor) {
    if (cursor) {
      switch (cursor.slotPtr.slot.tag) {
        case Tag.NONE:
        case Tag.ARRAY_LIST:
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

  getCursor(index: number): ReadCursor | null {
    return this.cursor.readPath([new ArrayListGet(index)]);
  }

  getSlot(index: number): Slot | null {
    return this.cursor.readPathSlot([new ArrayListGet(index)]);
  }
}

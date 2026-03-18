import { Tag } from './tag';
import { Slot } from './slot';
import type { Slotted } from './slotted';
import { ReadCursor, CursorIterator } from './read-cursor';
import { ArrayListGet } from './database';
import { UnexpectedTagException } from './exceptions';

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

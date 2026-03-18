import { Tag } from './tag';
import { ReadHashSet } from './read-hash-set';
import { ReadCursor } from './read-cursor';
import { UnexpectedTagException } from './exceptions';

export class ReadCountedHashSet extends ReadHashSet {
  constructor(cursor: ReadCursor) {
    super();
    switch (cursor.slotPtr.slot.tag) {
      case Tag.NONE:
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET:
        this.cursor = cursor;
        break;
      default:
        throw new UnexpectedTagException();
    }
  }

  count(): number {
    return this.cursor.count();
  }
}

import { Tag } from './tag';
import { ReadHashMap } from './read-hash-map';
import { ReadCursor } from './read-cursor';
import { UnexpectedTagException } from './exceptions';

export class ReadCountedHashMap extends ReadHashMap {
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

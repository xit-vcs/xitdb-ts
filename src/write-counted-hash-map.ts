import { Tag } from './tag.js';
import { WriteHashMap } from './write-hash-map.js';
import { WriteCursor } from './write-cursor.js';
import { UnexpectedTagException } from './exceptions.js';

export class WriteCountedHashMap extends WriteHashMap {
  constructor(cursor: WriteCursor) {
    switch (cursor.slotPtr.slot.tag) {
      case Tag.NONE:
      case Tag.COUNTED_HASH_MAP:
      case Tag.COUNTED_HASH_SET:
        super(cursor, true);
        break;
      default:
        throw new UnexpectedTagException();
    }
  }

  count(): number {
    return this.cursor.count();
  }
}

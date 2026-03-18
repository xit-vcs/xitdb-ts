import { Tag } from './tag';
import { WriteHashMap } from './write-hash-map';
import { WriteCursor } from './write-cursor';
import { UnexpectedTagException } from './exceptions';

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

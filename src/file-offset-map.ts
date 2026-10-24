import type { OffsetMap } from './offset-map.js';
import type { WriteCursor } from './write-cursor.js';
import { WriteHashMap } from './write-hash-map.js';
import { Uint } from './writeable-data.js';

/**
 * stores compaction offsets in a hash map in a separate scratch database
 * (usually a file) without retaining the mappings in memory. create it with a
 * cursor from a transaction on the scratch database, such as the one that
 * `runContext` provides, and compact inside that same transaction, so the
 * offsets aren't each committed separately.
 */
export class FileOffsetMap implements OffsetMap {
  private map: WriteHashMap;

  constructor(cursor: WriteCursor) {
    this.map = new WriteHashMap(cursor);
  }

  clear(): void {
    const cursor = this.map.cursor as WriteCursor;
    cursor.write(null);
    this.map = new WriteHashMap(cursor);
  }

  get(sourceOffset: number): number | undefined {
    const cursor = this.map.getCursor(this.key(sourceOffset));
    return cursor === null ? undefined : cursor.readUint();
  }

  set(sourceOffset: number, targetOffset: number): void {
    this.map.put(this.key(sourceOffset), new Uint(targetOffset));
  }

  private key(offset: number): Uint8Array {
    // encode the offset directly rather than hashing it, preserving exact keys
    const hashSize = this.map.cursor.db.header.hashSize;
    const key = new Uint8Array(hashSize);
    new DataView(key.buffer).setBigUint64(hashSize - 8, BigInt(offset), false);
    return key;
  }
}

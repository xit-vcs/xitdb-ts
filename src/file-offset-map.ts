import { CoreFile } from './core-file.js';
import { Database } from './database.js';
import { Hasher } from './hasher.js';
import type { OffsetMap } from './offset-map.js';
import { ReadHashMap } from './read-hash-map.js';
import { WriteHashMap } from './write-hash-map.js';
import { Uint } from './writeable-data.js';

/**
 * stores compaction offsets in a separate scratch database without retaining
 * the mappings in memory. the file is truncated on construction and clear,
 * and is closed on disposal or failed construction. the caller deletes it.
 */
export class FileOffsetMap implements OffsetMap, Disposable {
  private static readonly HASH_SIZE = 32;

  private readonly core: CoreFile;
  private readonly hasher = new Hasher('SHA-256');
  private db!: Database;

  constructor(filePath: string) {
    this.core = new class extends CoreFile {
      override sync(): void {
        // scratch mappings do not need crash durability
      }
    }(filePath);
    try {
      this.clear();
    } catch (error) {
      try {
        this.core[Symbol.dispose]();
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'Failed to initialize and close offsets map');
      }
      throw error;
    }
  }

  clear(): void {
    this.core.setLength(0);
    this.db = new Database(this.core, this.hasher);
  }

  get(sourceOffset: number): number | undefined {
    const map = new ReadHashMap(this.db.rootCursor());
    const cursor = map.getCursor(FileOffsetMap.key(sourceOffset));
    return cursor === null ? undefined : cursor.readUint();
  }

  set(sourceOffset: number, targetOffset: number): void {
    const map = new WriteHashMap(this.db.rootCursor());
    map.put(FileOffsetMap.key(sourceOffset), new Uint(targetOffset));
  }

  private static key(offset: number): Uint8Array {
    // encode the offset directly rather than hashing it, preserving exact keys
    const key = new Uint8Array(FileOffsetMap.HASH_SIZE);
    new DataView(key.buffer).setBigInt64(FileOffsetMap.HASH_SIZE - 8, BigInt(offset), false);
    return key;
  }

  [Symbol.dispose](): void {
    this.core[Symbol.dispose]();
  }
}

import { ReadHashSet } from './read-hash-set.js';
import { WriteCursor, WriteCursorIterator } from './write-cursor.js';
import { HashMapInit, HashMapGet, HashMapGetKey, HashMapRemove, Context } from './database.js';
import type { WriteableData } from './writeable-data.js';
import { Bytes } from './writeable-data.js';
import { KeyNotFoundException } from './exceptions.js';

export class WriteHashSet extends ReadHashSet {
  constructor(cursor: WriteCursor, counted?: boolean);
  constructor(cursor: WriteCursor, counted: boolean = false) {
    super();
    this.cursor = cursor.writePath([new HashMapInit(counted, true)]);
  }

  override iterator(): WriteCursorIterator {
    return (this.cursor as WriteCursor).iterator();
  }

  // put overloads (for sets, put takes only the key)
  put(key: string): void;
  put(key: Bytes): void;
  put(hash: Uint8Array, data: WriteableData): void;
  put(key: string | Bytes | Uint8Array, data?: WriteableData): void {
    if (typeof key === 'string') {
      const bytes = new TextEncoder().encode(key);
      const hash = this.cursor.db.hasher.digest(bytes);
      this.putInternal(hash, new Bytes(bytes));
    } else if (key instanceof Bytes) {
      const hash = this.cursor.db.hasher.digest(key.value);
      this.putInternal(hash, key);
    } else {
      this.putInternal(key, data!);
    }
  }

  // putCursor overloads
  putCursor(key: string): WriteCursor;
  putCursor(key: Bytes): WriteCursor;
  putCursor(hash: Uint8Array): WriteCursor;
  putCursor(key: string | Bytes | Uint8Array): WriteCursor {
    const hash = this.resolveHash(key);
    return this.putCursorInternal(hash);
  }

  // remove overloads
  remove(key: string): boolean;
  remove(key: Bytes): boolean;
  remove(hash: Uint8Array): boolean;
  remove(key: string | Bytes | Uint8Array): boolean {
    const hash = this.resolveHash(key);
    try {
      (this.cursor as WriteCursor).writePath([new HashMapRemove(hash)]);
    } catch (e) {
      if (e instanceof KeyNotFoundException) {
        return false;
      }
      throw e;
    }
    return true;
  }

  // Internal methods that take hash directly
  private putInternal(hash: Uint8Array, data: WriteableData): void {
    // the key is written in the same write as the lookup, so this works
    // even when the map is the root of the database, where each write is
    // its own transaction. keys are only written if empty,
    // because their value should always be the same at a given hash.
    (this.cursor as WriteCursor).writePath([
      new HashMapGet(new HashMapGetKey(hash)),
      new Context((cursor: WriteCursor) => cursor.writeIfEmpty(data)),
    ]);
  }

  private putCursorInternal(hash: Uint8Array): WriteCursor {
    return (this.cursor as WriteCursor).writePath([
      new HashMapGet(new HashMapGetKey(hash)),
    ]);
  }
}

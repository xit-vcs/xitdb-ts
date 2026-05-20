import { ReadHashSet } from './read-hash-set.js';
import { WriteCursor, WriteCursorIterator } from './write-cursor.js';
import { HashMapInit, HashMapGet, HashMapGetKey, HashMapRemove } from './database.js';
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

  override *[Symbol.iterator](): Iterator<WriteCursor> {
    yield* this.cursor as WriteCursor;
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
    const cursor = (this.cursor as WriteCursor).writePath([
      new HashMapGet(new HashMapGetKey(hash)),
    ]);
    cursor.writeIfEmpty(data);
  }

  private putCursorInternal(hash: Uint8Array): WriteCursor {
    return (this.cursor as WriteCursor).writePath([
      new HashMapGet(new HashMapGetKey(hash)),
    ]);
  }
}

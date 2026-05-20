import { ReadHashMap } from './read-hash-map.js';
import { WriteCursor, WriteCursorIterator, WriteKeyValuePairCursor } from './write-cursor.js';
import {
  HashMapInit,
  HashMapGet,
  HashMapGetValue,
  HashMapGetKey,
  HashMapRemove,
  WriteData,
} from './database.js';
import type { WriteableData } from './writeable-data.js';
import { Bytes } from './writeable-data.js';
import { KeyNotFoundException } from './exceptions.js';

export class WriteHashMap extends ReadHashMap {
  constructor(cursor: WriteCursor, counted?: boolean);
  constructor(cursor: WriteCursor, counted: boolean = false) {
    super();
    this.cursor = cursor.writePath([new HashMapInit(counted, false)]);
  }

  override iterator(): WriteCursorIterator {
    return (this.cursor as WriteCursor).iterator();
  }

  override *[Symbol.iterator](): Iterator<WriteCursor> {
    yield* this.cursor as WriteCursor;
  }

  // put overloads
  put(key: string, data: WriteableData): void;
  put(key: Bytes, data: WriteableData): void;
  put(hash: Uint8Array, data: WriteableData): void;
  put(key: string | Bytes | Uint8Array, data: WriteableData): void {
    if (typeof key === 'string') {
      const hash = this.cursor.db.hasher.digest(new TextEncoder().encode(key));
      this.putKeyInternal(hash, new Bytes(key));
      this.putInternal(hash, data);
    } else if (key instanceof Bytes) {
      const hash = this.cursor.db.hasher.digest(key.value);
      this.putKeyInternal(hash, key);
      this.putInternal(hash, data);
    } else {
      this.putInternal(key, data);
    }
  }

  // putCursor overloads
  putCursor(key: string): WriteCursor;
  putCursor(key: Bytes): WriteCursor;
  putCursor(hash: Uint8Array): WriteCursor;
  putCursor(key: string | Bytes | Uint8Array): WriteCursor {
    if (typeof key === 'string') {
      const hash = this.cursor.db.hasher.digest(new TextEncoder().encode(key));
      this.putKeyInternal(hash, new Bytes(key));
      return this.putCursorInternal(hash);
    } else if (key instanceof Bytes) {
      const hash = this.cursor.db.hasher.digest(key.value);
      this.putKeyInternal(hash, key);
      return this.putCursorInternal(hash);
    } else {
      return this.putCursorInternal(key);
    }
  }

  // putKey overloads
  putKey(key: string, data: WriteableData): void;
  putKey(key: Bytes, data: WriteableData): void;
  putKey(hash: Uint8Array, data: WriteableData): void;
  putKey(key: string | Bytes | Uint8Array, data: WriteableData): void {
    const hash = this.resolveHash(key);
    this.putKeyInternal(hash, data);
  }

  // putKeyCursor overloads
  putKeyCursor(key: string): WriteCursor;
  putKeyCursor(key: Bytes): WriteCursor;
  putKeyCursor(hash: Uint8Array): WriteCursor;
  putKeyCursor(key: string | Bytes | Uint8Array): WriteCursor {
    const hash = this.resolveHash(key);
    return this.putKeyCursorInternal(hash);
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
    (this.cursor as WriteCursor).writePath([
      new HashMapGet(new HashMapGetValue(hash)),
      new WriteData(data),
    ]);
  }

  private putCursorInternal(hash: Uint8Array): WriteCursor {
    return (this.cursor as WriteCursor).writePath([
      new HashMapGet(new HashMapGetValue(hash)),
    ]);
  }

  private putKeyInternal(hash: Uint8Array, data: WriteableData): void {
    const cursor = (this.cursor as WriteCursor).writePath([
      new HashMapGet(new HashMapGetKey(hash)),
    ]);
    cursor.writeIfEmpty(data);
  }

  private putKeyCursorInternal(hash: Uint8Array): WriteCursor {
    return (this.cursor as WriteCursor).writePath([
      new HashMapGet(new HashMapGetKey(hash)),
    ]);
  }
}

import { test, describe } from 'node:test';
import { expect } from './expect.ts';
import {
  Database,
  Tag,
  Hasher,
  Core,
  CoreMemory,
  CoreFile,
  CoreBufferedFile,
  Bytes,
  Uint,
  Int,
  Float,
  Slot,
  InvalidDatabaseException,
  InvalidVersionException,
  KeyNotFoundException,
  EndOfStreamException,
  ArrayListInit,
  ArrayListGet,
  ArrayListAppend,
  ArrayListSlice,
  HashMapInit,
  HashMapGet,
  HashMapGetValue,
  HashMapGetKey,
  HashMapRemove,
  LinkedArrayListInit,
  LinkedArrayListGet,
  LinkedArrayListAppend,
  LinkedArrayListSlice,
  LinkedArrayListConcat,
  LinkedArrayListInsert,
  LinkedArrayListRemove,
  WriteData,
  Context,
  VERSION,
  SLOT_COUNT,
  MASK,
} from '../src';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

const MAX_READ_BYTES = 1024;

describe('Low Level API', () => {
  test('in-memory storage', () => {
    const core = new CoreMemory();
    const hasher = new Hasher('SHA-1');
    testLowLevelApi(core, hasher);
  });

  test('file storage', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xitdb-'));
    const filePath = join(tmpDir, 'test.db');
    try {
      using core = new CoreFile(filePath);
      const hasher = new Hasher('SHA-1');
      testLowLevelApi(core, hasher);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  }, 20000);

  test('buffered file storage', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xitdb-'));
    const filePath = join(tmpDir, 'test.db');
    try {
      using core = new CoreBufferedFile(filePath);
      const hasher = new Hasher('SHA-1');
      testLowLevelApi(core, hasher);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  }, 20000);

  test('low level memory operations', () => {
    const core = new CoreMemory();
    const hasher = new Hasher('SHA-1');
    const db = new Database(core, hasher);

    const hash = db.hasher.digest(new TextEncoder().encode("text"));
    const textCursor = db.rootCursor().writePath([
      new HashMapInit(),
      new HashMapGet(new HashMapGetValue(hash)),
    ]);

    const writer = textCursor.writer();
    writer.write(new TextEncoder().encode('goodbye, world!'));
    writer.seek(9);
    writer.write(new TextEncoder().encode('cruel world!'));
    writer.finish();

    const reader = textCursor.reader();
    const allBytes = new Uint8Array(Number(textCursor.count()));
    reader.readFully(allBytes);
    expect(new TextDecoder().decode(allBytes)).toBe('goodbye, cruel world!');
  });
});

function testLowLevelApi(core: Core, hasher: Hasher): void {
  // open and re-open database
  {
    // make empty database
    core.setLength(0);
    new Database(core, hasher);

    // re-open without error
    let db = new Database(core, hasher);
    const writer = db.core.writer();
    db.core.seek(0);
    writer.writeByte('g'.charCodeAt(0));

    // re-open with error
    expect(() => new Database(core, hasher)).toThrow(InvalidDatabaseException);

    // modify the version
    db.core.seek(0);
    writer.writeByte('x'.charCodeAt(0));
    db.core.seek(4);
    writer.writeShort(VERSION + 1);

    // re-open with error
    expect(() => new Database(core, hasher)).toThrow(InvalidVersionException);
  }

  // save hash id in header
  {
    const hashId = Hasher.stringToId('sha1');
    const hasherWithHashId = new Hasher('SHA-1', hashId);

    // make empty database
    core.setLength(0);
    const db = new Database(core, hasherWithHashId);

    // verify hash id was stored
    expect(db.hasher.id).toBe(hashId);
    expect(Hasher.idToString(db.hasher.id)).toBe('sha1');
  }

  // array_list of hash_maps
  {
    core.setLength(0);
    const db = new Database(core, hasher);
    const rootCursor = db.rootCursor();

    // write foo -> bar with a writer
    const fooKey = db.hasher.digest(new TextEncoder().encode('foo'));
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetValue(fooKey)),
      new Context((cursor) => {
        expect(cursor.slot().tag).toBe(Tag.NONE);
        const writer = cursor.writer();
        writer.write(new TextEncoder().encode('bar'));
        writer.finish();
      }),
    ]);

    // read foo
    {
      const barCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(fooKey)),
      ]);
      expect(barCursor!.count()).toBe(3);
      const barValue = barCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(barValue)).toBe('bar');
    }

    // read foo from ctx
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetValue(fooKey)),
      new Context((cursor) => {
        expect(cursor.slot().tag).not.toBe(Tag.NONE);

        const value = cursor.readBytes(MAX_READ_BYTES);
        expect(new TextDecoder().decode(value)).toBe('bar');

        const barReader = cursor.reader();

        // read into buffer
        const barBytes = new Uint8Array(10);
        const barSize = barReader.read(barBytes);
        expect(new TextDecoder().decode(barBytes.slice(0, barSize))).toBe('bar');
        barReader.seek(0);
        expect(barReader.read(barBytes)).toBe(3);
        expect(new TextDecoder().decode(barBytes.slice(0, 3))).toBe('bar');

        // read one char at a time
        {
          const ch = new Uint8Array(1);
          barReader.seek(0);

          barReader.readFully(ch);
          expect(new TextDecoder().decode(ch)).toBe('b');

          barReader.readFully(ch);
          expect(new TextDecoder().decode(ch)).toBe('a');

          barReader.readFully(ch);
          expect(new TextDecoder().decode(ch)).toBe('r');

          expect(() => barReader.readFully(ch)).toThrow(EndOfStreamException);

          barReader.seek(1);
          expect(String.fromCharCode(barReader.readByte())).toBe('a');

          barReader.seek(0);
          expect(String.fromCharCode(barReader.readByte())).toBe('b');
        }
      }),
    ]);

    // overwrite foo -> baz
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetValue(fooKey)),
      new Context((cursor) => {
        expect(cursor.slot().tag).not.toBe(Tag.NONE);

        const writer = cursor.writer();
        writer.write(new TextEncoder().encode('x'));
        writer.write(new TextEncoder().encode('x'));
        writer.write(new TextEncoder().encode('x'));
        writer.seek(0);
        writer.write(new TextEncoder().encode('b'));
        writer.seek(2);
        writer.write(new TextEncoder().encode('z'));
        writer.seek(1);
        writer.write(new TextEncoder().encode('a'));
        writer.finish();

        const value = cursor.readBytes(MAX_READ_BYTES);
        expect(new TextDecoder().decode(value)).toBe('baz');
      }),
    ]);

    // if error in ctx, db doesn't change
    {
      const sizeBefore = core.length();

      try {
        rootCursor.writePath([
          new ArrayListInit(),
          new ArrayListAppend(),
          new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
          new HashMapInit(false, false),
          new HashMapGet(new HashMapGetValue(fooKey)),
          new Context((cursor) => {
            const writer = cursor.writer();
            writer.write(new TextEncoder().encode("this value won't be visible"));
            writer.finish();
            throw new Error();
          }),
        ]);
      } catch (e) {}

      // read foo
      const valueCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(fooKey)),
      ]);
      const value = valueCursor!.readBytes();
      expect(new TextDecoder().decode(value)).toBe('baz');

      // verify that the db is properly truncated back to its original size after error
      const sizeAfter = core.length();
      expect(sizeBefore).toBe(sizeAfter);
    }

    // write bar -> longstring
    const barKey = db.hasher.digest(new TextEncoder().encode('bar'));
    {
      const barCursor = rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(barKey)),
      ]);
      barCursor.write(new Bytes('longstring'));

      // the slot tag is BYTES because the byte array is > 8 bytes long
      expect(barCursor.slot().tag).toBe(Tag.BYTES);

      // writing again returns the same slot
      {
        const nextBarCursor = rootCursor.writePath([
          new ArrayListInit(),
          new ArrayListAppend(),
          new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
          new HashMapInit(false, false),
          new HashMapGet(new HashMapGetValue(barKey)),
        ]);
        nextBarCursor.writeIfEmpty(new Bytes('longstring'));
        expect(barCursor.slot().value).toBe(nextBarCursor.slot().value);
      }

      // writing with write returns a new slot
      {
        const nextBarCursor = rootCursor.writePath([
          new ArrayListInit(),
          new ArrayListAppend(),
          new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
          new HashMapInit(false, false),
          new HashMapGet(new HashMapGetValue(barKey)),
        ]);
        nextBarCursor.write(new Bytes('longstring'));
        expect(barCursor.slot().value).not.toBe(nextBarCursor.slot().value);
      }
    }

    // read bar
    {
      const readBarCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(barKey)),
      ]);
      const barValue = readBarCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(barValue)).toBe('longstring');
    }

    // write bar -> shortstr
    {
      const barCursor = rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(barKey)),
      ]);
      barCursor.write(new Bytes('shortstr'));

      // the slot tag is SHORT_BYTES because the byte array is <= 8 bytes long
      expect(barCursor.slot().tag).toBe(Tag.SHORT_BYTES);
      expect(barCursor.count()).toBe(8);

      // make sure that SHORT_BYTES can be read with a reader
      const barReader = barCursor.reader();
      const barValue = new Uint8Array(Number(barCursor.count()));
      barReader.readFully(barValue);
      expect(new TextDecoder().decode(barValue)).toBe('shortstr');
    }

    // write bytes with a format tag - shortstr
    {
      const barCursor = rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(barKey)),
      ]);
      barCursor.write(new Bytes('shortstr', new TextEncoder().encode('st')));

      // the slot tag is BYTES because the byte array is > 8 bytes long including the format tag
      expect(barCursor.slot().tag).toBe(Tag.BYTES);
      expect(barCursor.count()).toBe(8);

      // read bar
      const readBarCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(barKey)),
      ]);
      const barBytes = readBarCursor!.readBytesObject(MAX_READ_BYTES);
      expect(new TextDecoder().decode(barBytes.value)).toBe('shortstr');
      expect(new TextDecoder().decode(barBytes.formatTag!)).toBe('st');

      // make sure that BYTES can be read with a reader
      const barReader = barCursor.reader();
      const barValue = new Uint8Array(Number(barCursor.count()));
      barReader.readFully(barValue);
      expect(new TextDecoder().decode(barValue)).toBe('shortstr');
    }

    // write bytes with a format tag - shorts
    {
      const barCursor = rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(barKey)),
      ]);
      barCursor.write(new Bytes('shorts', new TextEncoder().encode('st')));

      // the slot tag is SHORT_BYTES because the byte array is <= 8 bytes long including the format tag
      expect(barCursor.slot().tag).toBe(Tag.SHORT_BYTES);
      expect(barCursor.count()).toBe(6);

      // read bar
      const readBarCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(barKey)),
      ]);
      const barBytes = readBarCursor!.readBytesObject(MAX_READ_BYTES);
      expect(new TextDecoder().decode(barBytes.value)).toBe('shorts');
      expect(new TextDecoder().decode(barBytes.formatTag!)).toBe('st');

      // make sure that SHORT_BYTES can be read with a reader
      const barReader = barCursor.reader();
      const barValue = new Uint8Array(Number(barCursor.count()));
      barReader.readFully(barValue);
      expect(new TextDecoder().decode(barValue)).toBe('shorts');
    }

    // write bytes with a format tag - short
    {
      const barCursor = rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(barKey)),
      ]);
      barCursor.write(new Bytes('short', new TextEncoder().encode('st')));

      // the slot tag is SHORT_BYTES because the byte array is <= 8 bytes long including the format tag
      expect(barCursor.slot().tag).toBe(Tag.SHORT_BYTES);
      expect(barCursor.count()).toBe(5);

      // read bar
      const readBarCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(barKey)),
      ]);
      const barBytes = readBarCursor!.readBytesObject(MAX_READ_BYTES);
      expect(new TextDecoder().decode(barBytes.value)).toBe('short');
      expect(new TextDecoder().decode(barBytes.formatTag!)).toBe('st');

      // make sure that SHORT_BYTES can be read with a reader
      const barReader = barCursor.reader();
      const barValue = new Uint8Array(Number(barCursor.count()));
      barReader.readFully(barValue);
      expect(new TextDecoder().decode(barValue)).toBe('short');
    }

    // read foo into buffer
    {
      const barCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(fooKey)),
      ]);
      const barBufferValue = barCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(barBufferValue)).toBe('baz');
    }

    // write bar and get a pointer to it
    const barSlot = (
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(barKey)),
        new WriteData(new Bytes('bar')),
      ])
    ).slot();

    // overwrite foo -> bar using the bar pointer
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetValue(fooKey)),
      new WriteData(barSlot),
    ]);
    const barCursor = rootCursor.readPath([
      new ArrayListGet(-1),
      new HashMapGet(new HashMapGetValue(fooKey)),
    ]);
    const barValue = barCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(barValue)).toBe('bar');

    // can still read the old value
    const bazCursor = rootCursor.readPath([
      new ArrayListGet(-2),
      new HashMapGet(new HashMapGetValue(fooKey)),
    ]);
    const bazValue = bazCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(bazValue)).toBe('baz');

    // key not found
    const notFoundKey = db.hasher.digest(new TextEncoder().encode("this doesn't exist"));
    expect(
      rootCursor.readPath([new ArrayListGet(-2), new HashMapGet(new HashMapGetValue(notFoundKey))])
    ).toBeNull();

    // write key that conflicts with foo the first two bytes
    const smallConflictKey = db.hasher.digest(new TextEncoder().encode('small conflict'));
    smallConflictKey[smallConflictKey.length - 1] = fooKey[fooKey.length - 1];
    smallConflictKey[smallConflictKey.length - 2] = fooKey[fooKey.length - 2];
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetValue(smallConflictKey)),
      new WriteData(new Bytes('small')),
    ]);

    // write key that conflicts with foo the first four bytes
    const conflictKey = db.hasher.digest(new TextEncoder().encode('conflict'));
    conflictKey[conflictKey.length - 1] = fooKey[fooKey.length - 1];
    conflictKey[conflictKey.length - 2] = fooKey[fooKey.length - 2];
    conflictKey[conflictKey.length - 3] = fooKey[fooKey.length - 3];
    conflictKey[conflictKey.length - 4] = fooKey[fooKey.length - 4];
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetValue(conflictKey)),
      new WriteData(new Bytes('hello')),
    ]);

    // read conflicting key
    const helloCursor = rootCursor.readPath([
      new ArrayListGet(-1),
      new HashMapGet(new HashMapGetValue(conflictKey)),
    ]);
    const helloValue = helloCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(helloValue)).toBe('hello');

    // we can still read foo
    const barCursor2 = rootCursor.readPath([
      new ArrayListGet(-1),
      new HashMapGet(new HashMapGetValue(fooKey)),
    ]);
    const barValue2 = barCursor2!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(barValue2)).toBe('bar');

    // overwrite conflicting key
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetValue(conflictKey)),
      new WriteData(new Bytes('goodbye')),
    ]);
    const goodbyeCursor = rootCursor.readPath([
      new ArrayListGet(-1),
      new HashMapGet(new HashMapGetValue(conflictKey)),
    ]);
    const goodbyeValue = goodbyeCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(goodbyeValue)).toBe('goodbye');

    // we can still read the old conflicting key
    const helloCursor2 = rootCursor.readPath([
      new ArrayListGet(-2),
      new HashMapGet(new HashMapGetValue(conflictKey)),
    ]);
    const helloValue2 = helloCursor2!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(helloValue2)).toBe('hello');

    // remove the conflicting keys
    {
      // foo's slot is an INDEX slot due to the conflict
      {
        const mapCursor = rootCursor.readPath([new ArrayListGet(-1)]);
        expect(mapCursor!.slot().tag).toBe(Tag.HASH_MAP);

        const i = Number(BigInt.asUintN(64, bytesToBigInt(fooKey)) & MASK);
        const slotPos = Number(mapCursor!.slot().value) + Slot.LENGTH * i;
        core.seek(slotPos);
        const reader = core.reader();
        const slotBytes = new Uint8Array(Slot.LENGTH);
        reader.readFully(slotBytes);
        const slot = Slot.fromBytes(slotBytes);

        expect(slot.tag).toBe(Tag.INDEX);
      }

      // remove the small conflict key
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapRemove(smallConflictKey),
      ]);

      // the conflict key still exists in history
      expect(
        rootCursor.readPath([new ArrayListGet(-2), new HashMapGet(new HashMapGetValue(smallConflictKey))])
      ).not.toBeNull();

      // the conflict key doesn't exist in the latest moment
      expect(
        rootCursor.readPath([new ArrayListGet(-1), new HashMapGet(new HashMapGetValue(smallConflictKey))])
      ).toBeNull();

      // the other conflict key still exists
      expect(
        rootCursor.readPath([new ArrayListGet(-1), new HashMapGet(new HashMapGetValue(conflictKey))])
      ).not.toBeNull();

      // foo's slot is still an INDEX slot due to the other conflicting key
      {
        const mapCursor = rootCursor.readPath([new ArrayListGet(-1)]);
        expect(mapCursor!.slot().tag).toBe(Tag.HASH_MAP);

        const i = Number(BigInt.asUintN(64, bytesToBigInt(fooKey)) & MASK);
        const slotPos = Number(mapCursor!.slot().value) + Slot.LENGTH * i;
        core.seek(slotPos);
        const reader = core.reader();
        const slotBytes = new Uint8Array(Slot.LENGTH);
        reader.readFully(slotBytes);
        const slot = Slot.fromBytes(slotBytes);

        expect(slot.tag).toBe(Tag.INDEX);
      }

      // remove the conflict key
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapRemove(conflictKey),
      ]);

      // the conflict keys don't exist in the latest moment
      expect(
        rootCursor.readPath([new ArrayListGet(-1), new HashMapGet(new HashMapGetValue(smallConflictKey))])
      ).toBeNull();
      expect(
        rootCursor.readPath([new ArrayListGet(-1), new HashMapGet(new HashMapGetValue(conflictKey))])
      ).toBeNull();

      // foo's slot is now a KV_PAIR slot, because the branch was shortened
      {
        const mapCursor = rootCursor.readPath([new ArrayListGet(-1)]);
        expect(mapCursor!.slot().tag).toBe(Tag.HASH_MAP);

        const i = Number(BigInt.asUintN(64, bytesToBigInt(fooKey)) & MASK);
        const slotPos = Number(mapCursor!.slot().value) + Slot.LENGTH * i;
        core.seek(slotPos);
        const reader = core.reader();
        const slotBytes = new Uint8Array(Slot.LENGTH);
        reader.readFully(slotBytes);
        const slot = Slot.fromBytes(slotBytes);

        expect(slot.tag).toBe(Tag.KV_PAIR);
      }
    }

    // overwrite foo with uint, int, float
    {
      // overwrite foo with a uint
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(fooKey)),
        new WriteData(new Uint(42)),
      ]);

      // read foo
      const uintValue = (
        rootCursor.readPath([new ArrayListGet(-1), new HashMapGet(new HashMapGetValue(fooKey))])
      )!.readUint();
      expect(uintValue).toBe(42);
    }

    {
      // overwrite foo with an int
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(fooKey)),
        new WriteData(new Int(-42)),
      ]);

      // read foo
      const intValue = (
        rootCursor.readPath([new ArrayListGet(-1), new HashMapGet(new HashMapGetValue(fooKey))])
      )!.readInt();
      expect(intValue).toBe(-42);
    }

    {
      // overwrite foo with a float
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(fooKey)),
        new WriteData(new Float(42.5)),
      ]);

      // read foo
      const floatValue = (
        rootCursor.readPath([new ArrayListGet(-1), new HashMapGet(new HashMapGetValue(fooKey))])
      )!.readFloat();
      expect(floatValue).toBe(42.5);
    }

    // remove foo
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapRemove(fooKey),
    ]);

    // remove key that does not exist
    expect(() =>
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapRemove(db.hasher.digest(new TextEncoder().encode("doesn't exist"))),
      ])
    ).toThrow(KeyNotFoundException);

    // make sure foo doesn't exist anymore
    expect(
      rootCursor.readPath([new ArrayListGet(-1), new HashMapGet(new HashMapGetValue(fooKey))])
    ).toBeNull();

    // non-top-level list
    {
      const fruitsKey = db.hasher.digest(new TextEncoder().encode('fruits'));

      // write apple
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(fruitsKey)),
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(new Bytes('apple')),
      ]);

      // read apple
      const appleCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(fruitsKey)),
        new ArrayListGet(-1),
      ]);
      const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(appleValue)).toBe('apple');

      // write banana
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(fruitsKey)),
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(new Bytes('banana')),
      ]);

      // read banana
      const bananaCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(fruitsKey)),
        new ArrayListGet(-1),
      ]);
      const bananaValue = bananaCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(bananaValue)).toBe('banana');

      // can't read banana in older array_list
      expect(
        rootCursor.readPath([
          new ArrayListGet(-2),
          new HashMapGet(new HashMapGetValue(fruitsKey)),
          new ArrayListGet(1),
        ])
      ).toBeNull();

      // write pear
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(fruitsKey)),
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(new Bytes('pear')),
      ]);

      // write grape
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(fruitsKey)),
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(new Bytes('grape')),
      ]);

      // read pear
      const pearCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(fruitsKey)),
        new ArrayListGet(-2),
      ]);
      const pearValue = pearCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(pearValue)).toBe('pear');

      // read grape
      const grapeCursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(fruitsKey)),
        new ArrayListGet(-1),
      ]);
      const grapeValue = grapeCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(grapeValue)).toBe('grape');
    }
  }

  // append to top-level array_list many times, filling up the array_list until a root overflow occurs
  {
    core.setLength(0);
    const db = new Database(core, hasher);
    const rootCursor = db.rootCursor();

    const watKey = db.hasher.digest(new TextEncoder().encode('wat'));

    for (let i = 0; i < SLOT_COUNT + 1; i++) {
      const value = `wat${i}`;
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(watKey)),
        new WriteData(new Bytes(value)),
      ]);
    }

    // verify all values
    for (let i = 0; i < SLOT_COUNT + 1; i++) {
      const value = `wat${i}`;
      const cursor = rootCursor.readPath([
        new ArrayListGet(i),
        new HashMapGet(new HashMapGetValue(watKey)),
      ]);
      const value2 = new TextDecoder().decode(cursor!.readBytes(MAX_READ_BYTES));
      expect(value).toBe(value2);
    }

    // add more slots to cause a new index block to be created.
    // during that transaction, return an error so the transaction is cancelled,
    // causing truncation to happen. this test ensures that the new index block
    // is NOT truncated.
    for (let i = SLOT_COUNT + 1; i < SLOT_COUNT * 2 + 1; i++) {
      const value = `wat${i}`;
      const index = i;

      try {
        rootCursor.writePath([
          new ArrayListInit(),
          new ArrayListAppend(),
          new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
          new HashMapInit(false, false),
          new HashMapGet(new HashMapGetValue(watKey)),
          new WriteData(new Bytes(value)),
          new Context(() => {
            if (index === 32) {
              throw new Error('intentional error');
            }
          }),
        ]);
      } catch (e) {
        // expected error
      }
    }

    // try another append to make sure we still can.
    // if truncation destroyed the index block, this would fail.
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetValue(watKey)),
      new WriteData(new Bytes('wat32')),
    ]);

    // slice so it contains exactly SLOT_COUNT, so we have the old root again
    rootCursor.writePath([new ArrayListInit(), new ArrayListSlice(SLOT_COUNT)]);

    // we can iterate over the remaining slots
    for (let i = 0; i < SLOT_COUNT; i++) {
      const value = `wat${i}`;
      const cursor = rootCursor.readPath([
        new ArrayListGet(i),
        new HashMapGet(new HashMapGetValue(watKey)),
      ]);
      const value2 = new TextDecoder().decode(cursor!.readBytes(MAX_READ_BYTES));
      expect(value).toBe(value2);
    }

    // but we can't get the value that we sliced out of the array list
    expect(rootCursor.readPath([new ArrayListGet(SLOT_COUNT + 1)])).toBeNull();
  }

  // append to inner array_list many times, filling up the array_list until a root overflow occurs
  {
    core.setLength(0);
    const db = new Database(core, hasher);
    const rootCursor = db.rootCursor();

    for (let i = 0; i < SLOT_COUNT + 1; i++) {
      const value = `wat${i}`;
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(new Bytes(value)),
      ]);
    }

    // verify all values
    for (let i = 0; i < SLOT_COUNT + 1; i++) {
      const value = `wat${i}`;
      const cursor = rootCursor.readPath([new ArrayListGet(-1), new ArrayListGet(i)]);
      const value2 = new TextDecoder().decode(cursor!.readBytes(MAX_READ_BYTES));
      expect(value).toBe(value2);
    }

    // slice the inner array list so it contains exactly SLOT_COUNT, so we have the old root again
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListGet(-1),
      new ArrayListInit(),
      new ArrayListSlice(SLOT_COUNT),
    ]);

    // we can iterate over the remaining slots
    for (let i = 0; i < SLOT_COUNT; i++) {
      const value = `wat${i}`;
      const cursor = rootCursor.readPath([new ArrayListGet(-1), new ArrayListGet(i)]);
      const value2 = new TextDecoder().decode(cursor!.readBytes(MAX_READ_BYTES));
      expect(value).toBe(value2);
    }

    // but we can't get the value that we sliced out of the array list
    expect(rootCursor.readPath([new ArrayListGet(-1), new ArrayListGet(SLOT_COUNT + 1)])).toBeNull();

    // overwrite the last value with hello
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new ArrayListInit(),
      new ArrayListGet(-1),
      new WriteData(new Bytes('hello')),
    ]);

    // read last value
    {
      const cursor = rootCursor.readPath([new ArrayListGet(-1), new ArrayListGet(-1)]);
      const value = new TextDecoder().decode(cursor!.readBytes(MAX_READ_BYTES));
      expect(value).toBe('hello');
    }

    // overwrite the last value with goodbye
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new ArrayListInit(),
      new ArrayListGet(-1),
      new WriteData(new Bytes('goodbye')),
    ]);

    // read last value
    {
      const cursor = rootCursor.readPath([new ArrayListGet(-1), new ArrayListGet(-1)]);
      const value = new TextDecoder().decode(cursor!.readBytes(MAX_READ_BYTES));
      expect(value).toBe('goodbye');
    }

    // previous last value is still hello
    {
      const cursor = rootCursor.readPath([new ArrayListGet(-2), new ArrayListGet(-1)]);
      const value = new TextDecoder().decode(cursor!.readBytes(MAX_READ_BYTES));
      expect(value).toBe('hello');
    }
  }

  // iterate over inner array_list
  {
    core.setLength(0);
    const db = new Database(core, hasher);
    const rootCursor = db.rootCursor();

    // add wats
    for (let i = 0; i < 10; i++) {
      const value = `wat${i}`;
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(new Bytes(value)),
      ]);

      const cursor = rootCursor.readPath([new ArrayListGet(-1), new ArrayListGet(-1)]);
      const value2 = new TextDecoder().decode(cursor!.readBytes(MAX_READ_BYTES));
      expect(value).toBe(value2);
    }

    // iterate over array_list
    {
      const innerCursor = rootCursor.readPath([new ArrayListGet(-1)]);
      const iter = innerCursor!.iterator();
      let i = 0;
      while (iter.hasNext()) {
        const nextCursor = iter.next();
        const value = `wat${i}`;
        const value2 = new TextDecoder().decode(nextCursor!.readBytes(MAX_READ_BYTES));
        expect(value).toBe(value2);
        i += 1;
      }
      expect(i).toBe(10);
    }

    // set first slot to .none and make sure iteration still works
    {
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListGet(-1),
        new ArrayListInit(),
        new ArrayListGet(0),
        new WriteData(null),
      ]);
      const innerCursor = rootCursor.readPath([new ArrayListGet(-1)]);
      const iter = innerCursor!.iterator();
      let i = 0;
      while (iter.hasNext()) {
        iter.next();
        i += 1;
      }
      expect(i).toBe(10);
    }

    // get list slot
    const listCursor = rootCursor.readPath([new ArrayListGet(-1)]);
    expect(listCursor!.count()).toBe(10);
  }

  // iterate over inner hash_map
  {
    core.setLength(0);
    const db = new Database(core, hasher);
    const rootCursor = db.rootCursor();

    // add wats
    for (let i = 0; i < 10; i++) {
      const value = `wat${i}`;
      const watKey = db.hasher.digest(new TextEncoder().encode(value));
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new HashMapInit(false, false),
        new HashMapGet(new HashMapGetValue(watKey)),
        new WriteData(new Bytes(value)),
      ]);

      const cursor = rootCursor.readPath([
        new ArrayListGet(-1),
        new HashMapGet(new HashMapGetValue(watKey)),
      ]);
      const value2 = new TextDecoder().decode(cursor!.readBytes(MAX_READ_BYTES));
      expect(value).toBe(value2);
    }

    // add foo
    const fooKey = db.hasher.digest(new TextEncoder().encode('foo'));
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetKey(fooKey)),
      new WriteData(new Bytes('foo')),
    ]);
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapGet(new HashMapGetValue(fooKey)),
      new WriteData(new Uint(42)),
    ]);

    // remove a wat
    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new HashMapRemove(db.hasher.digest(new TextEncoder().encode('wat0'))),
    ]);

    // iterate over hash_map
    {
      const innerCursor = rootCursor.readPath([new ArrayListGet(-1)]);
      const iter = innerCursor!.iterator();
      let i = 0;
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        const kvPair = kvPairCursor!.readKeyValuePair();
        if (arraysEqual(kvPair.hash, fooKey)) {
          const key = new TextDecoder().decode(kvPair.keyCursor.readBytes(MAX_READ_BYTES));
          expect(key).toBe('foo');
          expect(kvPair.valueCursor.slotPtr.slot.value).toBe(42n);
        } else {
          const value = kvPair.valueCursor.readBytes(MAX_READ_BYTES);
          const hash = db.hasher.digest(value);
          expect(arraysEqual(kvPair.hash, hash)).toBe(true);
        }
        i += 1;
      }
      expect(i).toBe(10);
    }

    // iterate over hash_map with writeable cursor
    {
      const innerCursor = rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      ]);
      const iter = innerCursor.iterator();
      let i = 0;
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        const kvPair = kvPairCursor!.readKeyValuePair();
        if (arraysEqual(kvPair.hash, fooKey)) {
          kvPair.keyCursor.write(new Bytes('bar'));
        }
        i += 1;
      }
      expect(i).toBe(10);
    }
  }

  {
    // slice linked_array_list
    testSlice(core, hasher, SLOT_COUNT * 5 + 1, 10, 5);
    testSlice(core, hasher, SLOT_COUNT * 5 + 1, 0, SLOT_COUNT * 2);
    testSlice(core, hasher, SLOT_COUNT * 5, SLOT_COUNT * 3, SLOT_COUNT);
    testSlice(core, hasher, SLOT_COUNT * 5, SLOT_COUNT * 3, SLOT_COUNT * 2);
    testSlice(core, hasher, SLOT_COUNT * 2, 10, SLOT_COUNT);
    testSlice(core, hasher, 2, 0, 2);
    testSlice(core, hasher, 2, 1, 1);
    testSlice(core, hasher, 1, 0, 0);

    // concat linked_array_list
    testConcat(core, hasher, SLOT_COUNT * 5 + 1, SLOT_COUNT + 1);
    testConcat(core, hasher, SLOT_COUNT, SLOT_COUNT);
    testConcat(core, hasher, 1, 1);
    testConcat(core, hasher, 0, 0);

    // insert linked_array_list
    testInsertAndRemove(core, hasher, 1, 0);
    testInsertAndRemove(core, hasher, 10, 0);
    testInsertAndRemove(core, hasher, 10, 5);
    testInsertAndRemove(core, hasher, 10, 9);
    testInsertAndRemove(core, hasher, SLOT_COUNT * 5, SLOT_COUNT * 2);
  }

  // concat linked_array_list multiple times
  {
    core.setLength(0);
    const db = new Database(core, hasher);
    const rootCursor = db.rootCursor();

    const evenKey = db.hasher.digest(new TextEncoder().encode('even'));
    const comboKey = db.hasher.digest(new TextEncoder().encode('combo'));

    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new HashMapInit(false, false),
      new Context((cursor) => {
        // create list
        for (let i = 0; i < SLOT_COUNT + 1; i++) {
          const n = i * 2;
          cursor.writePath([
            new HashMapGet(new HashMapGetValue(evenKey)),
            new LinkedArrayListInit(),
            new LinkedArrayListAppend(),
            new WriteData(new Uint(n)),
          ]);
        }

        // get list slot
        const evenListCursor = cursor.readPath([new HashMapGet(new HashMapGetValue(evenKey))]);
        expect(evenListCursor!.count()).toBe(SLOT_COUNT + 1);

        // check all values in the new slice with an iterator
        {
          const innerCursor = cursor.readPath([new HashMapGet(new HashMapGetValue(evenKey))]);
          const iter = innerCursor!.iterator();
          let i = 0;
          while (iter.hasNext()) {
            iter.next();
            i += 1;
          }
          expect(i).toBe(SLOT_COUNT + 1);
        }

        // concat the list with itself multiple times.
        // since each list has 17 items, each concat will create a gap, causing a root overflow
        // before a normal array list would've.
        let comboListCursor = cursor.writePath([
          new HashMapGet(new HashMapGetValue(comboKey)),
          new WriteData(evenListCursor!.slotPtr.slot),
          new LinkedArrayListInit(),
        ]);
        for (let i = 0; i < 16; i++) {
          comboListCursor = comboListCursor.writePath([
            new LinkedArrayListConcat(evenListCursor!.slotPtr.slot),
          ]);
        }

        // append to the new list
        cursor.writePath([
          new HashMapGet(new HashMapGetValue(comboKey)),
          new LinkedArrayListAppend(),
          new WriteData(new Uint(3)),
        ]);

        // read the new value from the list
        expect(
          (cursor.readPath([new HashMapGet(new HashMapGetValue(comboKey)), new LinkedArrayListGet(-1)]))!.readUint()
        ).toBe(3);

        // append more to the new list
        for (let i = 0; i < 500; i++) {
          cursor.writePath([
            new HashMapGet(new HashMapGetValue(comboKey)),
            new LinkedArrayListAppend(),
            new WriteData(new Uint(1)),
          ]);
        }
      }),
    ]);
  }

  // append items to linked_array_list without setting their value
  {
    core.setLength(0);
    const db = new Database(core, hasher);
    const rootCursor = db.rootCursor();

    // appending without setting any value should work
    for (let i = 0; i < 8; i++) {
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new LinkedArrayListInit(),
        new LinkedArrayListAppend(),
      ]);
    }

    // explicitly writing a null slot should also work
    for (let i = 0; i < 8; i++) {
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new LinkedArrayListInit(),
        new LinkedArrayListAppend(),
        new WriteData(null),
      ]);
    }
  }

  // insert at beginning of linked_array_list many times
  {
    core.setLength(0);
    const db = new Database(core, hasher);
    const rootCursor = db.rootCursor();

    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new LinkedArrayListInit(),
      new LinkedArrayListAppend(),
      new WriteData(new Uint(42)),
    ]);

    for (let i = 0; i < 1000; i++) {
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new LinkedArrayListInit(),
        new LinkedArrayListInsert(0),
        new WriteData(new Uint(i)),
      ]);
    }
  }

  // insert at end of linked_array_list many times
  {
    core.setLength(0);
    const db = new Database(core, hasher);
    const rootCursor = db.rootCursor();

    rootCursor.writePath([
      new ArrayListInit(),
      new ArrayListAppend(),
      new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
      new LinkedArrayListInit(),
      new LinkedArrayListAppend(),
      new WriteData(new Uint(42)),
    ]);

    for (let i = 0; i < 1000; i++) {
      rootCursor.writePath([
        new ArrayListInit(),
        new ArrayListAppend(),
        new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
        new LinkedArrayListInit(),
        new LinkedArrayListInsert(i),
        new WriteData(new Uint(i)),
      ]);
    }
  }
}

// Helper function to compare Uint8Arrays
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Helper function to convert bytes to BigInt
function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

function testSlice(
  core: Core,
  hasher: Hasher,
  originalSize: number,
  sliceOffset: number,
  sliceSize: number
): void {
  core.setLength(0);
  const db = new Database(core, hasher);
  const rootCursor = db.rootCursor();

  const evenKey = db.hasher.digest(new TextEncoder().encode('even'));
  const evenSliceKey = db.hasher.digest(new TextEncoder().encode('even-slice'));
  const comboKey = db.hasher.digest(new TextEncoder().encode('combo'));

  rootCursor.writePath([
    new ArrayListInit(),
    new ArrayListAppend(),
    new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
    new HashMapInit(false, false),
    new Context((cursor) => {
      const values: number[] = [];

      // create list
      for (let i = 0; i < originalSize; i++) {
        const n = i * 2;
        values.push(n);
        cursor.writePath([
          new HashMapGet(new HashMapGetValue(evenKey)),
          new LinkedArrayListInit(),
          new LinkedArrayListAppend(),
          new WriteData(new Uint(n)),
        ]);
      }

      // slice list
      const evenListCursor = cursor.readPath([new HashMapGet(new HashMapGetValue(evenKey))]);
      const evenListSliceCursor = cursor.writePath([
        new HashMapGet(new HashMapGetValue(evenSliceKey)),
        new WriteData(evenListCursor!.slotPtr.slot),
        new LinkedArrayListInit(),
        new LinkedArrayListSlice(sliceOffset, sliceSize),
      ]);

      // check all the values in the new slice
      for (let i = 0; i < sliceSize; i++) {
        const val = values[sliceOffset + i];
        const n = (
          cursor.readPath([new HashMapGet(new HashMapGetValue(evenSliceKey)), new LinkedArrayListGet(i)])
        )!.readUint();
        expect(val).toBe(n);
      }

      // check all values in the new slice with an iterator
      {
        const iter = evenListSliceCursor.iterator();
        let i = 0;
        while (iter.hasNext()) {
          const numCursor = iter.next();
          expect(values[sliceOffset + i]).toBe(numCursor!.readUint());
          i += 1;
        }
        expect(sliceSize).toBe(i);
      }

      // there are no extra items
      expect(
        cursor.readPath([new HashMapGet(new HashMapGetValue(evenSliceKey)), new LinkedArrayListGet(sliceSize)])
      ).toBeNull();

      // concat the slice with itself
      cursor.writePath([
        new HashMapGet(new HashMapGetValue(comboKey)),
        new WriteData(evenListSliceCursor.slotPtr.slot),
        new LinkedArrayListInit(),
        new LinkedArrayListConcat(evenListSliceCursor.slotPtr.slot),
      ]);

      // check all values in the combo list
      const comboValues: number[] = [];
      comboValues.push(...values.slice(sliceOffset, sliceOffset + sliceSize));
      comboValues.push(...values.slice(sliceOffset, sliceOffset + sliceSize));
      for (let i = 0; i < comboValues.length; i++) {
        const n = (
          cursor.readPath([new HashMapGet(new HashMapGetValue(comboKey)), new LinkedArrayListGet(i)])
        )!.readUint();
        expect(comboValues[i]).toBe(n);
      }

      // append to the slice
      cursor.writePath([
        new HashMapGet(new HashMapGetValue(evenSliceKey)),
        new LinkedArrayListInit(),
        new LinkedArrayListAppend(),
        new WriteData(new Uint(3)),
      ]);

      // read the new value from the slice
      expect(
        (cursor.readPath([new HashMapGet(new HashMapGetValue(evenSliceKey)), new LinkedArrayListGet(-1)]))!
          .readUint()
      ).toBe(3);
    }),
  ]);
}

function testConcat(core: Core, hasher: Hasher, listASize: number, listBSize: number): void {
  core.setLength(0);
  const db = new Database(core, hasher);
  const rootCursor = db.rootCursor();

  const evenKey = db.hasher.digest(new TextEncoder().encode('even'));
  const oddKey = db.hasher.digest(new TextEncoder().encode('odd'));
  const comboKey = db.hasher.digest(new TextEncoder().encode('combo'));

  const values: number[] = [];

  rootCursor.writePath([
    new ArrayListInit(),
    new ArrayListAppend(),
    new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
    new HashMapInit(false, false),
    new Context((cursor) => {
      // create even list
      cursor.writePath([new HashMapGet(new HashMapGetValue(evenKey)), new LinkedArrayListInit()]);
      for (let i = 0; i < listASize; i++) {
        const n = i * 2;
        values.push(n);
        cursor.writePath([
          new HashMapGet(new HashMapGetValue(evenKey)),
          new LinkedArrayListInit(),
          new LinkedArrayListAppend(),
          new WriteData(new Uint(n)),
        ]);
      }

      // create odd list
      cursor.writePath([new HashMapGet(new HashMapGetValue(oddKey)), new LinkedArrayListInit()]);
      for (let i = 0; i < listBSize; i++) {
        const n = i * 2 + 1;
        values.push(n);
        cursor.writePath([
          new HashMapGet(new HashMapGetValue(oddKey)),
          new LinkedArrayListInit(),
          new LinkedArrayListAppend(),
          new WriteData(new Uint(n)),
        ]);
      }
    }),
  ]);

  rootCursor.writePath([
    new ArrayListInit(),
    new ArrayListAppend(),
    new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
    new HashMapInit(false, false),
    new Context((cursor) => {
      // get the even list
      const evenListCursor = cursor.readPath([new HashMapGet(new HashMapGetValue(evenKey))]);

      // get the odd list
      const oddListCursor = cursor.readPath([new HashMapGet(new HashMapGetValue(oddKey))]);

      // concat the lists
      const comboListCursor = cursor.writePath([
        new HashMapGet(new HashMapGetValue(comboKey)),
        new WriteData(evenListCursor!.slotPtr.slot),
        new LinkedArrayListInit(),
        new LinkedArrayListConcat(oddListCursor!.slotPtr.slot),
      ]);

      // check all values in the new list
      for (let i = 0; i < values.length; i++) {
        const n = (
          cursor.readPath([new HashMapGet(new HashMapGetValue(comboKey)), new LinkedArrayListGet(i)])
        )!.readUint();
        expect(values[i]).toBe(n);
      }

      // check all values in the new slice with an iterator
      {
        const iter = comboListCursor.iterator();
        let i = 0;
        while (iter.hasNext()) {
          const numCursor = iter.next();
          expect(values[i]).toBe(numCursor!.readUint());
          i += 1;
        }
        expect((evenListCursor!.count()) + (oddListCursor!.count())).toBe(i);
      }

      // there are no extra items
      expect(
        cursor.readPath([new HashMapGet(new HashMapGetValue(comboKey)), new LinkedArrayListGet(values.length)])
      ).toBeNull();
    }),
  ]);
}

function testInsertAndRemove(core: Core, hasher: Hasher, originalSize: number, insertIndex: number): void {
  core.setLength(0);
  const db = new Database(core, hasher);
  const rootCursor = db.rootCursor();

  const evenKey = db.hasher.digest(new TextEncoder().encode('even'));
  const evenInsertKey = db.hasher.digest(new TextEncoder().encode('even-insert'));
  const insertValue = 12345;

  rootCursor.writePath([
    new ArrayListInit(),
    new ArrayListAppend(),
    new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
    new HashMapInit(false, false),
    new Context((cursor) => {
      const values: number[] = [];

      // create list
      for (let i = 0; i < originalSize; i++) {
        if (i === insertIndex) {
          values.push(insertValue);
        }
        const n = i * 2;
        values.push(n);
        cursor.writePath([
          new HashMapGet(new HashMapGetValue(evenKey)),
          new LinkedArrayListInit(),
          new LinkedArrayListAppend(),
          new WriteData(new Uint(n)),
        ]);
      }

      // insert into list
      const evenListCursor = cursor.readPath([new HashMapGet(new HashMapGetValue(evenKey))]);
      const evenListInsertCursor = cursor.writePath([
        new HashMapGet(new HashMapGetValue(evenInsertKey)),
        new WriteData(evenListCursor!.slotPtr.slot),
        new LinkedArrayListInit(),
      ]);
      evenListInsertCursor.writePath([
        new LinkedArrayListInsert(insertIndex),
        new WriteData(new Uint(insertValue)),
      ]);

      // check all the values in the new list
      for (let i = 0; i < values.length; i++) {
        const val = values[i];
        const n = (
          cursor.readPath([new HashMapGet(new HashMapGetValue(evenInsertKey)), new LinkedArrayListGet(i)])
        )!.readUint();
        expect(val).toBe(n);
      }

      // check all values in the new list with an iterator
      {
        const iter = evenListInsertCursor.iterator();
        let i = 0;
        while (iter.hasNext()) {
          const numCursor = iter.next();
          expect(values[i]).toBe(numCursor!.readUint());
          i += 1;
        }
        expect(values.length).toBe(i);
      }

      // there are no extra items
      expect(
        cursor.readPath([
          new HashMapGet(new HashMapGetValue(evenInsertKey)),
          new LinkedArrayListGet(values.length),
        ])
      ).toBeNull();
    }),
  ]);

  rootCursor.writePath([
    new ArrayListInit(),
    new ArrayListAppend(),
    new WriteData(rootCursor.readPathSlot([new ArrayListGet(-1)])),
    new HashMapInit(false, false),
    new Context((cursor) => {
      const values: number[] = [];

      for (let i = 0; i < originalSize; i++) {
        const n = i * 2;
        values.push(n);
      }

      // remove inserted value from the list
      const evenListInsertCursor = cursor.writePath([
        new HashMapGet(new HashMapGetValue(evenInsertKey)),
        new LinkedArrayListRemove(insertIndex),
      ]);

      // check all the values in the new list
      for (let i = 0; i < values.length; i++) {
        const val = values[i];
        const n = (
          cursor.readPath([new HashMapGet(new HashMapGetValue(evenInsertKey)), new LinkedArrayListGet(i)])
        )!.readUint();
        expect(val).toBe(n);
      }

      // check all values in the new list with an iterator
      {
        const iter = evenListInsertCursor.iterator();
        let i = 0;
        while (iter.hasNext()) {
          const numCursor = iter.next();
          expect(values[i]).toBe(numCursor!.readUint());
          i += 1;
        }
        expect(values.length).toBe(i);
      }

      // there are no extra items
      expect(
        cursor.readPath([
          new HashMapGet(new HashMapGetValue(evenInsertKey)),
          new LinkedArrayListGet(values.length),
        ])
      ).toBeNull();
    }),
  ]);
}

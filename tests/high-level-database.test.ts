import { expect, test, describe } from 'bun:test';
import {
  Database,
  Tag,
  Hasher,
  Core,
  CoreMemory,
  CoreFile,
  CoreBufferedFile,
  ReadArrayList,
  WriteArrayList,
  ReadHashMap,
  WriteHashMap,
  ReadHashSet,
  WriteHashSet,
  ReadLinkedArrayList,
  WriteLinkedArrayList,
  ReadCountedHashMap,
  WriteCountedHashMap,
  ReadCountedHashSet,
  WriteCountedHashSet,
  Bytes,
  Uint,
  Int,
  Float,
  InvalidTopLevelTypeException,
} from '../src';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';

const MAX_READ_BYTES = 1024;

describe('High Level API', () => {
  test('in-memory storage', async () => {
    const core = new CoreMemory();
    const hasher = new Hasher('SHA-1');
    await testHighLevelApi(core, hasher, null);
  });

  test('file storage', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'xitdb-'));
    const filePath = join(tmpDir, 'test.db');
    try {
      using core = await CoreFile.create(filePath);
      const hasher = new Hasher('SHA-1');
      await testHighLevelApi(core, hasher, filePath);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('buffered file storage', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'xitdb-'));
    const filePath = join(tmpDir, 'test.db');
    try {
      using core = await CoreBufferedFile.create(filePath);
      const hasher = new Hasher('SHA-1');
      await testHighLevelApi(core, hasher, filePath);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('not using array list at top level', async () => {
    // hash map
    {
      const core = new CoreMemory();
      const hasher = new Hasher('SHA-1');
      const db = await Database.create(core, hasher);

      const map = await WriteHashMap.create(db.rootCursor());
      await map.put('foo', new Bytes('foo'));
      await map.put('bar', new Bytes('bar'));

      // init inner map
      {
        const innerMapCursor = await map.putCursor('inner-map');
        await WriteHashMap.create(innerMapCursor);
      }

      // re-init inner map
      {
        const innerMapCursor = await map.putCursor('inner-map');
        await WriteHashMap.create(innerMapCursor);
      }
    }

    // linked array list is not currently allowed at the top level
    {
      const core = new CoreMemory();
      const hasher = new Hasher('SHA-1');
      const db = await Database.create(core, hasher);

      await expect(WriteLinkedArrayList.create(db.rootCursor())).rejects.toThrow(
        InvalidTopLevelTypeException
      );
    }
  });

  test('read database from fixture', async () => {
    const filePath = new URL('./fixtures/test.db', import.meta.url).pathname;
    using core = await CoreFile.create(filePath);
    const hasher = new Hasher('SHA-1');
    const db = await Database.create(core, hasher);
    const history = new ReadArrayList(db.rootCursor());

    // First moment
    {
      const momentCursor = await history.getCursor(0);
      expect(momentCursor).not.toBeNull();
      const moment = new ReadHashMap(momentCursor!);

      const fooCursor = await moment.getCursor('foo');
      expect(fooCursor).not.toBeNull();
      const fooValue = await fooCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(fooValue)).toBe('foo');

      const fooSlot = await moment.getSlot('foo');
      expect(fooSlot?.tag).toBe(Tag.SHORT_BYTES);
      const barSlot = await moment.getSlot('bar');
      expect(barSlot?.tag).toBe(Tag.SHORT_BYTES);

      const fruitsCursor = await moment.getCursor('fruits');
      expect(fruitsCursor).not.toBeNull();
      const fruits = new ReadArrayList(fruitsCursor!);
      expect(await fruits.count()).toBe(3);

      const appleCursor = await fruits.getCursor(0);
      expect(appleCursor).not.toBeNull();
      const appleValue = await appleCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(appleValue)).toBe('apple');

      const peopleCursor = await moment.getCursor('people');
      expect(peopleCursor).not.toBeNull();
      const people = new ReadArrayList(peopleCursor!);
      expect(await people.count()).toBe(2);

      const aliceCursor = await people.getCursor(0);
      expect(aliceCursor).not.toBeNull();
      const alice = new ReadHashMap(aliceCursor!);
      const aliceAgeCursor = await alice.getCursor('age');
      expect(aliceAgeCursor).not.toBeNull();
      expect(aliceAgeCursor!.readUint()).toBe(25);

      const todosCursor = await moment.getCursor('todos');
      expect(todosCursor).not.toBeNull();
      const todos = new ReadLinkedArrayList(todosCursor!);
      expect(await todos.count()).toBe(3);

      const todoCursor = await todos.getCursor(0);
      expect(todoCursor).not.toBeNull();
      const todoValue = await todoCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(todoValue)).toBe('Pay the bills');

      // Test iterating over people
      const peopleIter = await people.iterator();
      while (await peopleIter.hasNext()) {
        const personCursor = await peopleIter.next();
        expect(personCursor).not.toBeNull();
        const person = new ReadHashMap(personCursor!);
        const personIter = await person.iterator();
        while (await personIter.hasNext()) {
          const kvPairCursor = await personIter.next();
          expect(kvPairCursor).not.toBeNull();
          await kvPairCursor!.readKeyValuePair();
        }
      }

      // Counted hash map
      {
        const lettersCountedMapCursor = await moment.getCursor('letters-counted-map');
        expect(lettersCountedMapCursor).not.toBeNull();
        const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
        expect(await lettersCountedMap.count()).toBe(2);

        const iter = await lettersCountedMap.iterator();
        let count = 0;
        while (await iter.hasNext()) {
          const kvPairCursor = await iter.next();
          expect(kvPairCursor).not.toBeNull();
          const kvPair = await kvPairCursor!.readKeyValuePair();
          await kvPair.keyCursor.readBytes(MAX_READ_BYTES);
          count += 1;
        }
        expect(count).toBe(2);
      }

      // Hash set
      {
        const lettersSetCursor = await moment.getCursor('letters-set');
        expect(lettersSetCursor).not.toBeNull();
        const lettersSet = new ReadHashSet(lettersSetCursor!);
        expect(await lettersSet.getCursor('a')).not.toBeNull();
        expect(await lettersSet.getCursor('c')).not.toBeNull();

        const iter = await lettersSet.iterator();
        let count = 0;
        while (await iter.hasNext()) {
          const kvPairCursor = await iter.next();
          expect(kvPairCursor).not.toBeNull();
          const kvPair = await kvPairCursor!.readKeyValuePair();
          await kvPair.keyCursor.readBytes(MAX_READ_BYTES);
          count += 1;
        }
        expect(count).toBe(2);
      }

      // Counted hash set
      {
        const lettersCountedSetCursor = await moment.getCursor('letters-counted-set');
        expect(lettersCountedSetCursor).not.toBeNull();
        const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
        expect(await lettersCountedSet.count()).toBe(2);

        const iter = await lettersCountedSet.iterator();
        let count = 0;
        while (await iter.hasNext()) {
          const kvPairCursor = await iter.next();
          expect(kvPairCursor).not.toBeNull();
          const kvPair = await kvPairCursor!.readKeyValuePair();
          await kvPair.keyCursor.readBytes(MAX_READ_BYTES);
          count += 1;
        }
        expect(count).toBe(2);
      }
    }

    // Second moment
    {
      const momentCursor = await history.getCursor(1);
      expect(momentCursor).not.toBeNull();
      const moment = new ReadHashMap(momentCursor!);

      expect(await moment.getCursor('bar')).toBeNull();

      const fruitsKeyCursor = await moment.getKeyCursor('fruits');
      expect(fruitsKeyCursor).not.toBeNull();
      const fruitsKeyValue = await fruitsKeyCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(fruitsKeyValue)).toBe('fruits');

      const fruitsCursor = await moment.getCursor('fruits');
      expect(fruitsCursor).not.toBeNull();
      const fruits = new ReadArrayList(fruitsCursor!);
      expect(await fruits.count()).toBe(2);

      const fruitsKVCursor = await moment.getKeyValuePair('fruits');
      expect(fruitsKVCursor).not.toBeNull();
      expect(fruitsKVCursor!.keyCursor.slotPtr.slot.tag).toBe(Tag.SHORT_BYTES);
      expect(fruitsKVCursor!.valueCursor.slotPtr.slot.tag).toBe(Tag.ARRAY_LIST);

      const lemonCursor = await fruits.getCursor(0);
      expect(lemonCursor).not.toBeNull();
      const lemonValue = await lemonCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(lemonValue)).toBe('lemon');

      const peopleCursor = await moment.getCursor('people');
      expect(peopleCursor).not.toBeNull();
      const people = new ReadArrayList(peopleCursor!);
      expect(await people.count()).toBe(2);

      const aliceCursor = await people.getCursor(0);
      expect(aliceCursor).not.toBeNull();
      const alice = new ReadHashMap(aliceCursor!);
      const aliceAgeCursor = await alice.getCursor('age');
      expect(aliceAgeCursor).not.toBeNull();
      expect(aliceAgeCursor!.readUint()).toBe(26);

      const todosCursor = await moment.getCursor('todos');
      expect(todosCursor).not.toBeNull();
      const todos = new ReadLinkedArrayList(todosCursor!);
      expect(await todos.count()).toBe(1);

      const todoCursor = await todos.getCursor(0);
      expect(todoCursor).not.toBeNull();
      const todoValue = await todoCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(todoValue)).toBe('Wash the car');

      const lettersCountedMapCursor = await moment.getCursor('letters-counted-map');
      expect(lettersCountedMapCursor).not.toBeNull();
      const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
      expect(await lettersCountedMap.count()).toBe(1);

      const lettersSetCursor = await moment.getCursor('letters-set');
      expect(lettersSetCursor).not.toBeNull();
      const lettersSet = new ReadHashSet(lettersSetCursor!);
      expect(await lettersSet.getCursor('a')).not.toBeNull();
      expect(await lettersSet.getCursor('c')).toBeNull();

      const lettersCountedSetCursor = await moment.getCursor('letters-counted-set');
      expect(lettersCountedSetCursor).not.toBeNull();
      const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
      expect(await lettersCountedSet.count()).toBe(1);
    }
  });
});

async function testHighLevelApi(core: Core, hasher: Hasher, filePath: string | null): Promise<void> {
  // init the db
  await core.setLength(0);
  let db = await Database.create(core, hasher);

  // First transaction
  {
    const history = await WriteArrayList.create(db.rootCursor());
    await history.appendContext(await history.getSlot(-1), async (cursor) => {
      const moment = await WriteHashMap.create(cursor);

      await moment.put('foo', new Bytes('foo'));
      await moment.put('bar', new Bytes('bar'));

      const fruitsCursor = await moment.putCursor('fruits');
      const fruits = await WriteArrayList.create(fruitsCursor);
      await fruits.append(new Bytes('apple'));
      await fruits.append(new Bytes('pear'));
      await fruits.append(new Bytes('grape'));

      const peopleCursor = await moment.putCursor('people');
      const people = await WriteArrayList.create(peopleCursor);

      const aliceCursor = await people.appendCursor();
      const alice = await WriteHashMap.create(aliceCursor);
      await alice.put('name', new Bytes('Alice'));
      await alice.put('age', new Uint(25));

      const bobCursor = await people.appendCursor();
      const bob = await WriteHashMap.create(bobCursor);
      await bob.put('name', new Bytes('Bob'));
      await bob.put('age', new Uint(42));

      const todosCursor = await moment.putCursor('todos');
      const todos = await WriteLinkedArrayList.create(todosCursor);
      await todos.append(new Bytes('Pay the bills'));
      await todos.append(new Bytes('Get an oil change'));
      await todos.insert(1, new Bytes('Wash the car'));

      // make sure insertCursor works as well
      const todoCursor = await todos.insertCursor(1);
      await WriteHashMap.create(todoCursor);
      await todos.remove(1);

      const lettersCountedMapCursor = await moment.putCursor('letters-counted-map');
      const lettersCountedMap = await WriteCountedHashMap.create(lettersCountedMapCursor);
      await lettersCountedMap.put('a', new Uint(1));
      await lettersCountedMap.put('a', new Uint(2));
      await lettersCountedMap.put('c', new Uint(2));

      const lettersSetCursor = await moment.putCursor('letters-set');
      const lettersSet = await WriteHashSet.create(lettersSetCursor);
      await lettersSet.put('a');
      await lettersSet.put('a');
      await lettersSet.put('c');

      const lettersCountedSetCursor = await moment.putCursor('letters-counted-set');
      const lettersCountedSet = await WriteCountedHashSet.create(lettersCountedSetCursor);
      await lettersCountedSet.put('a');
      await lettersCountedSet.put('a');
      await lettersCountedSet.put('c');

      // big int with format tag
      const bigIntBytes = new Uint8Array(32);
      bigIntBytes.fill(42); // deterministic bytes
      await moment.put('big-number', new Bytes(bigIntBytes, new TextEncoder().encode('bi')));

      // long text using writer
      const longTextCursor = await moment.putCursor('long-text');
      const cursorWriter = await longTextCursor.writer();
      for (let i = 0; i < 50; i++) {
        await cursorWriter.write(new TextEncoder().encode('hello, world\n'));
      }
      await cursorWriter.finish();
    });

    // Verify first transaction
    const momentCursor = await history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    const fooCursor = await moment.getCursor('foo');
    const fooValue = await fooCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(fooValue)).toBe('foo');

    expect((await moment.getSlot('foo'))?.tag).toBe(Tag.SHORT_BYTES);
    expect((await moment.getSlot('bar'))?.tag).toBe(Tag.SHORT_BYTES);

    const fruitsCursor = await moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(await fruits.count()).toBe(3);

    const appleCursor = await fruits.getCursor(0);
    const appleValue = await appleCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(appleValue)).toBe('apple');

    const peopleCursor = await moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    expect(await people.count()).toBe(2);

    const aliceCursor = await people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = await alice.getCursor('age');
    expect(aliceAgeCursor!.readUint()).toBe(25);

    const todosCursor = await moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(await todos.count()).toBe(3);

    const todoCursor = await todos.getCursor(0);
    const todoValue = await todoCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(todoValue)).toBe('Pay the bills');

    // iterate over people
    const peopleIter = await people.iterator();
    while (await peopleIter.hasNext()) {
      const personCursor = await peopleIter.next();
      const person = new ReadHashMap(personCursor!);
      const personIter = await person.iterator();
      while (await personIter.hasNext()) {
        const kvPairCursor = await personIter.next();
        const kvPair = await kvPairCursor!.readKeyValuePair();
        await kvPair.keyCursor.readBytes(MAX_READ_BYTES);

        switch (kvPair.valueCursor.slot().tag) {
          case Tag.SHORT_BYTES:
          case Tag.BYTES:
            await kvPair.valueCursor.readBytes(MAX_READ_BYTES);
            break;
          case Tag.UINT:
            kvPair.valueCursor.readUint();
            break;
          case Tag.INT:
            kvPair.valueCursor.readInt();
            break;
          case Tag.FLOAT:
            kvPair.valueCursor.readFloat();
            break;
        }
      }
    }

    // iterate over fruits
    const fruitsIter = await fruits.iterator();
    while (await fruitsIter.hasNext()) {
      await fruitsIter.next();
    }

    // Counted hash map
    {
      const lettersCountedMapCursor = await moment.getCursor('letters-counted-map');
      const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
      expect(await lettersCountedMap.count()).toBe(2);

      const iter = await lettersCountedMap.iterator();
      let count = 0;
      while (await iter.hasNext()) {
        const kvPairCursor = await iter.next();
        const kvPair = await kvPairCursor!.readKeyValuePair();
        await kvPair.keyCursor.readBytes(MAX_READ_BYTES);
        count += 1;
      }
      expect(count).toBe(2);
    }

    // Hash set
    {
      const lettersSetCursor = await moment.getCursor('letters-set');
      const lettersSet = new ReadHashSet(lettersSetCursor!);
      expect(await lettersSet.getCursor('a')).not.toBeNull();
      expect(await lettersSet.getCursor('c')).not.toBeNull();

      const iter = await lettersSet.iterator();
      let count = 0;
      while (await iter.hasNext()) {
        const kvPairCursor = await iter.next();
        const kvPair = await kvPairCursor!.readKeyValuePair();
        await kvPair.keyCursor.readBytes(MAX_READ_BYTES);
        count += 1;
      }
      expect(count).toBe(2);
    }

    // Counted hash set
    {
      const lettersCountedSetCursor = await moment.getCursor('letters-counted-set');
      const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
      expect(await lettersCountedSet.count()).toBe(2);

      const iter = await lettersCountedSet.iterator();
      let count = 0;
      while (await iter.hasNext()) {
        const kvPairCursor = await iter.next();
        const kvPair = await kvPairCursor!.readKeyValuePair();
        await kvPair.keyCursor.readBytes(MAX_READ_BYTES);
        count += 1;
      }
      expect(count).toBe(2);
    }

    // big number with format tag
    {
      const bigNumberCursor = await moment.getCursor('big-number');
      const bigNumber = await bigNumberCursor!.readBytesObject(MAX_READ_BYTES);
      expect(bigNumber.value.length).toBe(32);
      expect(bigNumber.value[0]).toBe(42);
      expect(new TextDecoder().decode(bigNumber.formatTag!)).toBe('bi');
    }

    // long text
    {
      const longTextCursor = await moment.getCursor('long-text');
      const cursorReader = await longTextCursor!.reader();
      let lineCount = 0, line: number[] = [];
      const buf = new Uint8Array(1024);
      for (let n; (n = await cursorReader.read(buf)) > 0; ) {
        for (let i = 0; i < n; i++) {
          if (buf[i] === 0x0A) { lineCount++; line = []; }
          else line.push(buf[i]);
        }
      }
      if (line.length > 0) lineCount++;
      expect(lineCount).toBe(50);
    }
  }

  // Second transaction - modify data
  {
    const history = await WriteArrayList.create(db.rootCursor());
    await history.appendContext(await history.getSlot(-1), async (cursor) => {
      const moment = await WriteHashMap.create(cursor);

      expect(await moment.remove('bar')).toBe(true);
      expect(await moment.remove("doesn't exist")).toBe(false);

      const fruitsCursor = await moment.putCursor('fruits');
      const fruits = await WriteArrayList.create(fruitsCursor);
      await fruits.put(0, new Bytes('lemon'));
      await fruits.slice(2);

      const peopleCursor = await moment.putCursor('people');
      const people = await WriteArrayList.create(peopleCursor);
      const aliceCursor = await people.putCursor(0);
      const alice = await WriteHashMap.create(aliceCursor);
      await alice.put('age', new Uint(26));

      const todosCursor = await moment.putCursor('todos');
      const todos = await WriteLinkedArrayList.create(todosCursor);
      await todos.concat(todosCursor.slot());
      await todos.slice(1, 2);
      await todos.remove(1);

      const lettersCountedMapCursor = await moment.putCursor('letters-counted-map');
      const lettersCountedMap = await WriteCountedHashMap.create(lettersCountedMapCursor);
      await lettersCountedMap.remove('b');
      await lettersCountedMap.remove('c');

      const lettersSetCursor = await moment.putCursor('letters-set');
      const lettersSet = await WriteHashSet.create(lettersSetCursor);
      await lettersSet.remove('b');
      await lettersSet.remove('c');

      const lettersCountedSetCursor = await moment.putCursor('letters-counted-set');
      const lettersCountedSet = await WriteCountedHashSet.create(lettersCountedSetCursor);
      await lettersCountedSet.remove('b');
      await lettersCountedSet.remove('c');
    });

    // Verify second transaction
    const momentCursor = await history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    expect(await moment.getCursor('bar')).toBeNull();

    const fruitsKeyCursor = await moment.getKeyCursor('fruits');
    const fruitsKeyValue = await fruitsKeyCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(fruitsKeyValue)).toBe('fruits');

    const fruitsCursor = await moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(await fruits.count()).toBe(2);

    const fruitsKVCursor = await moment.getKeyValuePair('fruits');
    expect(fruitsKVCursor!.keyCursor.slotPtr.slot.tag).toBe(Tag.SHORT_BYTES);
    expect(fruitsKVCursor!.valueCursor.slotPtr.slot.tag).toBe(Tag.ARRAY_LIST);

    const lemonCursor = await fruits.getCursor(0);
    const lemonValue = await lemonCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(lemonValue)).toBe('lemon');

    const peopleCursor = await moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    expect(await people.count()).toBe(2);

    const aliceCursor = await people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = await alice.getCursor('age');
    expect(aliceAgeCursor!.readUint()).toBe(26);

    const todosCursor = await moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(await todos.count()).toBe(1);

    const todoCursor = await todos.getCursor(0);
    const todoValue = await todoCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(todoValue)).toBe('Wash the car');

    const lettersCountedMapCursor = await moment.getCursor('letters-counted-map');
    const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
    expect(await lettersCountedMap.count()).toBe(1);

    const lettersSetCursor = await moment.getCursor('letters-set');
    const lettersSet = new ReadHashSet(lettersSetCursor!);
    expect(await lettersSet.getCursor('a')).not.toBeNull();
    expect(await lettersSet.getCursor('c')).toBeNull();

    const lettersCountedSetCursor = await moment.getCursor('letters-counted-set');
    const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
    expect(await lettersCountedSet.count()).toBe(1);
  }

  // The old data hasn't changed
  {
    const history = await WriteArrayList.create(db.rootCursor());
    const momentCursor = await history.getCursor(0);
    const moment = new ReadHashMap(momentCursor!);

    const fooCursor = await moment.getCursor('foo');
    const fooValue = await fooCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(fooValue)).toBe('foo');

    expect((await moment.getSlot('foo'))?.tag).toBe(Tag.SHORT_BYTES);
    expect((await moment.getSlot('bar'))?.tag).toBe(Tag.SHORT_BYTES);

    const fruitsCursor = await moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(await fruits.count()).toBe(3);

    const appleCursor = await fruits.getCursor(0);
    const appleValue = await appleCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(appleValue)).toBe('apple');

    const peopleCursor = await moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    expect(await people.count()).toBe(2);

    const aliceCursor = await people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = await alice.getCursor('age');
    expect(aliceAgeCursor!.readUint()).toBe(25);

    const todosCursor = await moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(await todos.count()).toBe(3);

    const todoCursor = await todos.getCursor(0);
    const todoValue = await todoCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(todoValue)).toBe('Pay the bills');
  }

  // Remove the last transaction with slice
  {
    const history = await WriteArrayList.create(db.rootCursor());
    await history.slice(1);

    const momentCursor = await history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    const fooCursor = await moment.getCursor('foo');
    const fooValue = await fooCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(fooValue)).toBe('foo');

    expect((await moment.getSlot('foo'))?.tag).toBe(Tag.SHORT_BYTES);
    expect((await moment.getSlot('bar'))?.tag).toBe(Tag.SHORT_BYTES);

    const fruitsCursor = await moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(await fruits.count()).toBe(3);

    const appleCursor = await fruits.getCursor(0);
    const appleValue = await appleCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(appleValue)).toBe('apple');

    const peopleCursor = await moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    expect(await people.count()).toBe(2);

    const aliceCursor = await people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = await alice.getCursor('age');
    expect(aliceAgeCursor!.readUint()).toBe(25);

    const todosCursor = await moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(await todos.count()).toBe(3);

    const todoCursor = await todos.getCursor(0);
    const todoValue = await todoCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(todoValue)).toBe('Pay the bills');
  }

  // The db size remains the same after writing junk data and then reinitializing the db
  {
    await core.seek(await core.length());
    const sizeBefore = await core.length();

    const writer = core.writer();
    await writer.write(new TextEncoder().encode('this is junk data that will be deleted during init'));

    db = await Database.create(core, hasher);

    const sizeAfter = await core.length();
    expect(sizeBefore).toBe(sizeAfter);
  }

  // Cloning
  {
    const history = await WriteArrayList.create(db.rootCursor());
    await history.appendContext(await history.getSlot(-1), async (cursor) => {
      const moment = await WriteHashMap.create(cursor);

      const fruitsCursor = await moment.getCursor('fruits');
      const fruits = new ReadArrayList(fruitsCursor!);

      // create a new key called "food" whose initial value is based on the "fruits" list
      const foodCursor = await moment.putCursor('food');
      await foodCursor.write(fruits.slot());

      const food = await WriteArrayList.create(foodCursor);
      await food.append(new Bytes('eggs'));
      await food.append(new Bytes('rice'));
      await food.append(new Bytes('fish'));
    });

    const momentCursor = await history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    // the food list includes the fruits
    const foodCursor = await moment.getCursor('food');
    const food = new ReadArrayList(foodCursor!);
    expect(await food.count()).toBe(6);

    // ...but the fruits list hasn't been changed
    const fruitsCursor = await moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(await fruits.count()).toBe(3);
  }

  // Accidental mutation when cloning inside a transaction
  {
    const history = await WriteArrayList.create(db.rootCursor());
    const historyIndex = (await history.count()) - 1;

    await history.appendContext(await history.getSlot(-1), async (cursor) => {
      const moment = await WriteHashMap.create(cursor);

      const bigCitiesCursor = await moment.putCursor('big-cities');
      const bigCities = await WriteArrayList.create(bigCitiesCursor);
      await bigCities.append(new Bytes('New York, NY'));
      await bigCities.append(new Bytes('Los Angeles, CA'));

      // create a new key called "cities" whose initial value is based on the "big-cities" list
      const citiesCursor = await moment.putCursor('cities');
      await citiesCursor.write(bigCities.slot());

      const cities = await WriteArrayList.create(citiesCursor);
      await cities.append(new Bytes('Charleston, SC'));
      await cities.append(new Bytes('Louisville, KY'));
    });

    const momentCursor = await history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    // the cities list contains all four
    const citiesCursor = await moment.getCursor('cities');
    const cities = new ReadArrayList(citiesCursor!);
    expect(await cities.count()).toBe(4);

    // ..but so does big-cities! we did not intend to mutate this
    const bigCitiesCursor = await moment.getCursor('big-cities');
    const bigCities = new ReadArrayList(bigCitiesCursor!);
    expect(await bigCities.count()).toBe(4);

    // revert that change
    await history.append((await history.getSlot(historyIndex))!);
  }

  // Preventing accidental mutation with freezing
  {
    const history = await WriteArrayList.create(db.rootCursor());
    await history.appendContext(await history.getSlot(-1), async (cursor) => {
      const moment = await WriteHashMap.create(cursor);

      const bigCitiesCursor = await moment.putCursor('big-cities');
      const bigCities = await WriteArrayList.create(bigCitiesCursor);
      await bigCities.append(new Bytes('New York, NY'));
      await bigCities.append(new Bytes('Los Angeles, CA'));

      // freeze here, so big-cities won't be mutated
      cursor.db.freeze();

      // create a new key called "cities" whose initial value is based on the "big-cities" list
      const citiesCursor = await moment.putCursor('cities');
      await citiesCursor.write(bigCities.slot());

      const cities = await WriteArrayList.create(citiesCursor);
      await cities.append(new Bytes('Charleston, SC'));
      await cities.append(new Bytes('Louisville, KY'));
    });

    const momentCursor = await history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    // the cities list contains all four
    const citiesCursor = await moment.getCursor('cities');
    const cities = new ReadArrayList(citiesCursor!);
    expect(await cities.count()).toBe(4);

    // and big-cities only contains the original two
    const bigCitiesCursor = await moment.getCursor('big-cities');
    const bigCities = new ReadArrayList(bigCitiesCursor!);
    expect(await bigCities.count()).toBe(2);
  }
}

describe('Compaction', () => {
  test('in-memory storage', async () => {
    const sourceCore = new CoreMemory();
    const targetCore = new CoreMemory();
    const hasher = new Hasher('SHA-1');
    await testCompaction(sourceCore, targetCore, hasher, null, null);
  });

  test('file storage', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'xitdb-compact-'));
    const sourcePath = join(tmpDir, 'source.db');
    const targetPath = join(tmpDir, 'target.db');
    try {
      using sourceCore = await CoreFile.create(sourcePath);
      using targetCore = await CoreFile.create(targetPath);
      const hasher = new Hasher('SHA-1');
      await testCompaction(sourceCore, targetCore, hasher, sourcePath, targetPath);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  test('buffered file storage', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'xitdb-compact-'));
    const sourcePath = join(tmpDir, 'source.db');
    const targetPath = join(tmpDir, 'target.db');
    try {
      using sourceCore = await CoreBufferedFile.create(sourcePath);
      using targetCore = await CoreBufferedFile.create(targetPath);
      const hasher = new Hasher('SHA-1');
      await testCompaction(sourceCore, targetCore, hasher, sourcePath, targetPath);
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});

async function testCompaction(
  sourceCore: Core,
  targetCore: Core,
  hasher: Hasher,
  sourcePath: string | null,
  targetPath: string | null
): Promise<void> {
  const decoder = new TextDecoder();

  // empty DB compaction
  {
    await sourceCore.setLength(0);
    await targetCore.setLength(0);
    const source = await Database.create(sourceCore, hasher);
    const compacted = await source.compact(targetCore);
    expect(compacted.header.tag).toBe(Tag.NONE);
  }

  // basic compaction with various data types
  {
    await sourceCore.setLength(0);
    await targetCore.setLength(0);
    const source = await Database.create(sourceCore, hasher);

    // moment 1
    {
      const history = await WriteArrayList.create(source.rootCursor());
      await history.appendContext(await history.getSlot(-1), async (cursor) => {
        const moment = await WriteHashMap.create(cursor);
        await moment.put('key1', new Bytes('value1'));
        await moment.put('key2', new Uint(100));
      });
    }

    // moment 2
    {
      const history = await WriteArrayList.create(source.rootCursor());
      await history.appendContext(await history.getSlot(-1), async (cursor) => {
        const moment = await WriteHashMap.create(cursor);
        await moment.put('key1', new Bytes('updated_value1'));
        await moment.put('key2', new Uint(200));
        await moment.put('key3', new Int(-42));
        await moment.put('key4', new Float(3.14));
        await moment.put('short', new Bytes('hi'));

        // long bytes with format_tag
        await moment.put('tagged', new Bytes(
          new TextEncoder().encode('this is a long tagged string!!'),
          new TextEncoder().encode('bi')
        ));

        // ArrayList
        const fruitsCursor = await moment.putCursor('fruits');
        const fruits = await WriteArrayList.create(fruitsCursor);
        await fruits.append(new Bytes('apple'));
        await fruits.append(new Bytes('banana'));
        await fruits.append(new Bytes('cherry'));

        // LinkedArrayList
        const todosCursor = await moment.putCursor('todos');
        const todos = await WriteLinkedArrayList.create(todosCursor);
        await todos.append(new Bytes('task1'));
        await todos.append(new Bytes('task2'));
        await todos.append(new Bytes('task3'));

        // CountedHashMap
        const countedCursor = await moment.putCursor('counted');
        const counted = await WriteCountedHashMap.create(countedCursor);
        await counted.put('a', new Uint(1));
        await counted.putKey('a', new Bytes('a'));
        await counted.put('b', new Uint(2));
        await counted.putKey('b', new Bytes('b'));

        // HashSet
        const setCursor = await moment.putCursor('myset');
        const set = await WriteHashSet.create(setCursor);
        await set.put('x');
        await set.put('y');

        // CountedHashSet
        const csetCursor = await moment.putCursor('mycset');
        const cset = await WriteCountedHashSet.create(csetCursor);
        await cset.put('p');
        await cset.put('q');
      });
    }

    // moment 3
    {
      const history = await WriteArrayList.create(source.rootCursor());
      await history.appendContext(await history.getSlot(-1), async (cursor) => {
        const moment = await WriteHashMap.create(cursor);
        await moment.put('key1', new Bytes('final_value'));
      });
    }

    const sourceSize = await sourceCore.length();

    // compact
    const compacted = await source.compact(targetCore);

    const targetSize = await targetCore.length();

    // target should be smaller than source (3 moments vs 1)
    expect(targetSize).toBeLessThan(sourceSize);

    // target should have exactly 1 moment
    const history = new ReadArrayList(compacted.rootCursor());
    expect(await history.count()).toBe(1);

    // verify all data from latest moment is correct
    const momentCursor = await history.getCursor(0);
    const moment = new ReadHashMap(momentCursor!);

    // key1 should have the final value
    expect(decoder.decode(await (await moment.getCursor('key1'))!.readBytes(MAX_READ_BYTES))).toBe('final_value');

    // key2 from moment 2
    expect((await moment.getCursor('key2'))!.readUint()).toBe(200);

    // key3 - int
    expect((await moment.getCursor('key3'))!.readInt()).toBe(-42);

    // key4 - float
    expect((await moment.getCursor('key4'))!.readFloat()).toBe(3.14);

    // short bytes
    expect(decoder.decode(await (await moment.getCursor('short'))!.readBytes(MAX_READ_BYTES))).toBe('hi');

    // tagged bytes
    const taggedObj = await (await moment.getCursor('tagged'))!.readBytesObject(MAX_READ_BYTES);
    expect(decoder.decode(taggedObj.value)).toBe('this is a long tagged string!!');
    expect(decoder.decode(taggedObj.formatTag!)).toBe('bi');

    // ArrayList
    const fruitsCursor = await moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(await fruits.count()).toBe(3);
    expect(decoder.decode(await (await fruits.getCursor(0))!.readBytes(MAX_READ_BYTES))).toBe('apple');
    expect(decoder.decode(await (await fruits.getCursor(2))!.readBytes(MAX_READ_BYTES))).toBe('cherry');

    // LinkedArrayList
    const todosCursor = await moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(await todos.count()).toBe(3);
    expect(decoder.decode(await (await todos.getCursor(0))!.readBytes(MAX_READ_BYTES))).toBe('task1');
    expect(decoder.decode(await (await todos.getCursor(2))!.readBytes(MAX_READ_BYTES))).toBe('task3');

    // CountedHashMap
    const countedCursor = await moment.getCursor('counted');
    const counted = new ReadCountedHashMap(countedCursor!);
    expect(await counted.count()).toBe(2);
    expect((await counted.getCursor('a'))!.readUint()).toBe(1);
    expect((await counted.getCursor('b'))!.readUint()).toBe(2);

    // HashSet
    const setCursor = await moment.getCursor('myset');
    const set = new ReadHashSet(setCursor!);
    expect(decoder.decode(await (await set.getCursor('x'))!.readBytes(MAX_READ_BYTES))).toBe('x');

    // CountedHashSet
    const csetCursor = await moment.getCursor('mycset');
    const cset = new ReadCountedHashSet(csetCursor!);
    expect(await cset.count()).toBe(2);
    expect(decoder.decode(await (await cset.getCursor('p'))!.readBytes(MAX_READ_BYTES))).toBe('p');
  }

  // structural sharing (most data shared, only 1 key changes per moment)
  {
    await sourceCore.setLength(0);
    await targetCore.setLength(0);
    const source = await Database.create(sourceCore, hasher);

    // moment 1: create many keys
    {
      const history = await WriteArrayList.create(source.rootCursor());
      await history.appendContext(await history.getSlot(-1), async (cursor) => {
        const moment = await WriteHashMap.create(cursor);
        for (let i = 0; i < 20; i++) {
          await moment.put(`shared_key_${i}`, new Uint(i));
        }
      });
    }

    // moments 2-5: change only one key each time
    for (let round = 0; round < 4; round++) {
      const history = await WriteArrayList.create(source.rootCursor());
      await history.appendContext(await history.getSlot(-1), async (cursor) => {
        const moment = await WriteHashMap.create(cursor);
        await moment.put('changing_key', new Uint(round + 100));
      });
    }

    const compacted = await source.compact(targetCore);

    const history = new ReadArrayList(compacted.rootCursor());
    expect(await history.count()).toBe(1);

    const momentCursor = await history.getCursor(0);
    const moment = new ReadHashMap(momentCursor!);

    // verify shared keys are intact
    for (let i = 0; i < 20; i++) {
      expect((await moment.getCursor(`shared_key_${i}`))!.readUint()).toBe(i);
    }

    // verify changing key has latest value
    expect((await moment.getCursor('changing_key'))!.readUint()).toBe(103);
  }

  // re-open after compact and compact-then-continue-writing
  // (only meaningful for file modes)
  if (sourcePath !== null && targetPath !== null) {
    // re-open after compact
    {
      await sourceCore.setLength(0);
      await targetCore.setLength(0);
      const source = await Database.create(sourceCore, hasher);

      // write some data
      {
        const history = await WriteArrayList.create(source.rootCursor());
        await history.appendContext(await history.getSlot(-1), async (cursor) => {
          const moment = await WriteHashMap.create(cursor);
          await moment.put('persist', new Bytes('persistent_value'));
          await moment.put('number', new Uint(999));
        });
      }

      // compact
      await source.compact(targetCore);

      // re-open the target
      await targetCore.seek(0);
      const reopened = await Database.create(targetCore, hasher);

      const history = new ReadArrayList(reopened.rootCursor());
      expect(await history.count()).toBe(1);

      const momentCursor = await history.getCursor(0);
      const moment = new ReadHashMap(momentCursor!);
      expect(decoder.decode(await (await moment.getCursor('persist'))!.readBytes(MAX_READ_BYTES))).toBe('persistent_value');
      expect((await moment.getCursor('number'))!.readUint()).toBe(999);
    }

    // compact then continue writing
    {
      await sourceCore.setLength(0);
      await targetCore.setLength(0);
      const source = await Database.create(sourceCore, hasher);

      // write initial data
      {
        const history = await WriteArrayList.create(source.rootCursor());
        await history.appendContext(await history.getSlot(-1), async (cursor) => {
          const moment = await WriteHashMap.create(cursor);
          await moment.put('original', new Bytes('original_data'));
        });
      }

      // compact
      const compacted = await source.compact(targetCore);

      // add new moment to compacted DB
      {
        const history = await WriteArrayList.create(compacted.rootCursor());
        await history.appendContext(await history.getSlot(-1), async (cursor) => {
          const moment = await WriteHashMap.create(cursor);
          await moment.put('new_key', new Bytes('new_data'));
        });
      }

      // verify both old and new data
      const history = new ReadArrayList(compacted.rootCursor());
      expect(await history.count()).toBe(2);

      // moment 0 (compacted original)
      const m0Cursor = await history.getCursor(0);
      const m0 = new ReadHashMap(m0Cursor!);
      expect(decoder.decode(await (await m0.getCursor('original'))!.readBytes(MAX_READ_BYTES))).toBe('original_data');

      // moment 1 (new data added after compact)
      const m1Cursor = await history.getCursor(1);
      const m1 = new ReadHashMap(m1Cursor!);
      expect(decoder.decode(await (await m1.getCursor('new_key'))!.readBytes(MAX_READ_BYTES))).toBe('new_data');

      // original data should still be in moment 1 (inherited)
      expect(decoder.decode(await (await m1.getCursor('original'))!.readBytes(MAX_READ_BYTES))).toBe('original_data');
    }
  }
}
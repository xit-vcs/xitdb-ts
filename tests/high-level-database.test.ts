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
import { mkdtempSync, rmSync } from 'fs';

const MAX_READ_BYTES = 1024;

describe('High Level API', () => {
  test('in-memory storage', () => {
    const core = new CoreMemory();
    const hasher = new Hasher('SHA-1');
    testHighLevelApi(core, hasher, null);
  });

  test('file storage', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xitdb-'));
    const filePath = join(tmpDir, 'test.db');
    try {
      using core = new CoreFile(filePath);
      const hasher = new Hasher('SHA-1');
      testHighLevelApi(core, hasher, filePath);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('buffered file storage', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xitdb-'));
    const filePath = join(tmpDir, 'test.db');
    try {
      using core = new CoreBufferedFile(filePath);
      const hasher = new Hasher('SHA-1');
      testHighLevelApi(core, hasher, filePath);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('not using array list at top level', () => {
    // hash map
    {
      const core = new CoreMemory();
      const hasher = new Hasher('SHA-1');
      const db = new Database(core, hasher);

      const map = new WriteHashMap(db.rootCursor());
      map.put('foo', new Bytes('foo'));
      map.put('bar', new Bytes('bar'));

      // init inner map
      {
        const innerMapCursor = map.putCursor('inner-map');
        new WriteHashMap(innerMapCursor);
      }

      // re-init inner map
      {
        const innerMapCursor = map.putCursor('inner-map');
        new WriteHashMap(innerMapCursor);
      }
    }

    // linked array list is not currently allowed at the top level
    {
      const core = new CoreMemory();
      const hasher = new Hasher('SHA-1');
      const db = new Database(core, hasher);

      expect(() => new WriteLinkedArrayList(db.rootCursor())).toThrow(
        InvalidTopLevelTypeException
      );
    }
  });

  test('read database from fixture', () => {
    const filePath = new URL('./fixtures/test.db', import.meta.url).pathname;
    using core = new CoreFile(filePath);
    const hasher = new Hasher('SHA-1');
    const db = new Database(core, hasher);
    const history = new ReadArrayList(db.rootCursor());

    // First moment
    {
      const momentCursor = history.getCursor(0);
      expect(momentCursor).not.toBeNull();
      const moment = new ReadHashMap(momentCursor!);

      const fooCursor = moment.getCursor('foo');
      expect(fooCursor).not.toBeNull();
      const fooValue = fooCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(fooValue)).toBe('foo');

      const fooSlot = moment.getSlot('foo');
      expect(fooSlot?.tag).toBe(Tag.SHORT_BYTES);
      const barSlot = moment.getSlot('bar');
      expect(barSlot?.tag).toBe(Tag.SHORT_BYTES);

      const fruitsCursor = moment.getCursor('fruits');
      expect(fruitsCursor).not.toBeNull();
      const fruits = new ReadArrayList(fruitsCursor!);
      expect(fruits.count()).toBe(3);

      const appleCursor = fruits.getCursor(0);
      expect(appleCursor).not.toBeNull();
      const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(appleValue)).toBe('apple');

      const peopleCursor = moment.getCursor('people');
      expect(peopleCursor).not.toBeNull();
      const people = new ReadArrayList(peopleCursor!);
      expect(people.count()).toBe(2);

      const aliceCursor = people.getCursor(0);
      expect(aliceCursor).not.toBeNull();
      const alice = new ReadHashMap(aliceCursor!);
      const aliceAgeCursor = alice.getCursor('age');
      expect(aliceAgeCursor).not.toBeNull();
      expect(aliceAgeCursor!.readUint()).toBe(25);

      const todosCursor = moment.getCursor('todos');
      expect(todosCursor).not.toBeNull();
      const todos = new ReadLinkedArrayList(todosCursor!);
      expect(todos.count()).toBe(3);

      const todoCursor = todos.getCursor(0);
      expect(todoCursor).not.toBeNull();
      const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(todoValue)).toBe('Pay the bills');

      // Test iterating over people
      const peopleIter = people.iterator();
      while (peopleIter.hasNext()) {
        const personCursor = peopleIter.next();
        expect(personCursor).not.toBeNull();
        const person = new ReadHashMap(personCursor!);
        const personIter = person.iterator();
        while (personIter.hasNext()) {
          const kvPairCursor = personIter.next();
          expect(kvPairCursor).not.toBeNull();
          kvPairCursor!.readKeyValuePair();
        }
      }

      // Counted hash map
      {
        const lettersCountedMapCursor = moment.getCursor('letters-counted-map');
        expect(lettersCountedMapCursor).not.toBeNull();
        const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
        expect(lettersCountedMap.count()).toBe(2);

        const iter = lettersCountedMap.iterator();
        let count = 0;
        while (iter.hasNext()) {
          const kvPairCursor = iter.next();
          expect(kvPairCursor).not.toBeNull();
          const kvPair = kvPairCursor!.readKeyValuePair();
          kvPair.keyCursor.readBytes(MAX_READ_BYTES);
          count += 1;
        }
        expect(count).toBe(2);
      }

      // Hash set
      {
        const lettersSetCursor = moment.getCursor('letters-set');
        expect(lettersSetCursor).not.toBeNull();
        const lettersSet = new ReadHashSet(lettersSetCursor!);
        expect(lettersSet.getCursor('a')).not.toBeNull();
        expect(lettersSet.getCursor('c')).not.toBeNull();

        const iter = lettersSet.iterator();
        let count = 0;
        while (iter.hasNext()) {
          const kvPairCursor = iter.next();
          expect(kvPairCursor).not.toBeNull();
          const kvPair = kvPairCursor!.readKeyValuePair();
          kvPair.keyCursor.readBytes(MAX_READ_BYTES);
          count += 1;
        }
        expect(count).toBe(2);
      }

      // Counted hash set
      {
        const lettersCountedSetCursor = moment.getCursor('letters-counted-set');
        expect(lettersCountedSetCursor).not.toBeNull();
        const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
        expect(lettersCountedSet.count()).toBe(2);

        const iter = lettersCountedSet.iterator();
        let count = 0;
        while (iter.hasNext()) {
          const kvPairCursor = iter.next();
          expect(kvPairCursor).not.toBeNull();
          const kvPair = kvPairCursor!.readKeyValuePair();
          kvPair.keyCursor.readBytes(MAX_READ_BYTES);
          count += 1;
        }
        expect(count).toBe(2);
      }
    }

    // Second moment
    {
      const momentCursor = history.getCursor(1);
      expect(momentCursor).not.toBeNull();
      const moment = new ReadHashMap(momentCursor!);

      expect(moment.getCursor('bar')).toBeNull();

      const fruitsKeyCursor = moment.getKeyCursor('fruits');
      expect(fruitsKeyCursor).not.toBeNull();
      const fruitsKeyValue = fruitsKeyCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(fruitsKeyValue)).toBe('fruits');

      const fruitsCursor = moment.getCursor('fruits');
      expect(fruitsCursor).not.toBeNull();
      const fruits = new ReadArrayList(fruitsCursor!);
      expect(fruits.count()).toBe(2);

      const fruitsKVCursor = moment.getKeyValuePair('fruits');
      expect(fruitsKVCursor).not.toBeNull();
      expect(fruitsKVCursor!.keyCursor.slotPtr.slot.tag).toBe(Tag.SHORT_BYTES);
      expect(fruitsKVCursor!.valueCursor.slotPtr.slot.tag).toBe(Tag.ARRAY_LIST);

      const lemonCursor = fruits.getCursor(0);
      expect(lemonCursor).not.toBeNull();
      const lemonValue = lemonCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(lemonValue)).toBe('lemon');

      const peopleCursor = moment.getCursor('people');
      expect(peopleCursor).not.toBeNull();
      const people = new ReadArrayList(peopleCursor!);
      expect(people.count()).toBe(2);

      const aliceCursor = people.getCursor(0);
      expect(aliceCursor).not.toBeNull();
      const alice = new ReadHashMap(aliceCursor!);
      const aliceAgeCursor = alice.getCursor('age');
      expect(aliceAgeCursor).not.toBeNull();
      expect(aliceAgeCursor!.readUint()).toBe(26);

      const todosCursor = moment.getCursor('todos');
      expect(todosCursor).not.toBeNull();
      const todos = new ReadLinkedArrayList(todosCursor!);
      expect(todos.count()).toBe(1);

      const todoCursor = todos.getCursor(0);
      expect(todoCursor).not.toBeNull();
      const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
      expect(new TextDecoder().decode(todoValue)).toBe('Wash the car');

      const lettersCountedMapCursor = moment.getCursor('letters-counted-map');
      expect(lettersCountedMapCursor).not.toBeNull();
      const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
      expect(lettersCountedMap.count()).toBe(1);

      const lettersSetCursor = moment.getCursor('letters-set');
      expect(lettersSetCursor).not.toBeNull();
      const lettersSet = new ReadHashSet(lettersSetCursor!);
      expect(lettersSet.getCursor('a')).not.toBeNull();
      expect(lettersSet.getCursor('c')).toBeNull();

      const lettersCountedSetCursor = moment.getCursor('letters-counted-set');
      expect(lettersCountedSetCursor).not.toBeNull();
      const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
      expect(lettersCountedSet.count()).toBe(1);
    }
  });
});

function testHighLevelApi(core: Core, hasher: Hasher, filePath: string | null): void {
  // init the db
  core.setLength(0);
  let db = new Database(core, hasher);

  // First transaction
  {
    const history = new WriteArrayList(db.rootCursor());
    history.appendContext(history.getSlot(-1), (cursor) => {
      const moment = new WriteHashMap(cursor);

      moment.put('foo', new Bytes('foo'));
      moment.put('bar', new Bytes('bar'));

      const fruitsCursor = moment.putCursor('fruits');
      const fruits = new WriteArrayList(fruitsCursor);
      fruits.append(new Bytes('apple'));
      fruits.append(new Bytes('pear'));
      fruits.append(new Bytes('grape'));

      const peopleCursor = moment.putCursor('people');
      const people = new WriteArrayList(peopleCursor);

      const aliceCursor = people.appendCursor();
      const alice = new WriteHashMap(aliceCursor);
      alice.put('name', new Bytes('Alice'));
      alice.put('age', new Uint(25));

      const bobCursor = people.appendCursor();
      const bob = new WriteHashMap(bobCursor);
      bob.put('name', new Bytes('Bob'));
      bob.put('age', new Uint(42));

      const todosCursor = moment.putCursor('todos');
      const todos = new WriteLinkedArrayList(todosCursor);
      todos.append(new Bytes('Pay the bills'));
      todos.append(new Bytes('Get an oil change'));
      todos.insert(1, new Bytes('Wash the car'));

      // make sure insertCursor works as well
      const todoCursor = todos.insertCursor(1);
      new WriteHashMap(todoCursor);
      todos.remove(1);

      const lettersCountedMapCursor = moment.putCursor('letters-counted-map');
      const lettersCountedMap = new WriteCountedHashMap(lettersCountedMapCursor);
      lettersCountedMap.put('a', new Uint(1));
      lettersCountedMap.put('a', new Uint(2));
      lettersCountedMap.put('c', new Uint(2));

      const lettersSetCursor = moment.putCursor('letters-set');
      const lettersSet = new WriteHashSet(lettersSetCursor);
      lettersSet.put('a');
      lettersSet.put('a');
      lettersSet.put('c');

      const lettersCountedSetCursor = moment.putCursor('letters-counted-set');
      const lettersCountedSet = new WriteCountedHashSet(lettersCountedSetCursor);
      lettersCountedSet.put('a');
      lettersCountedSet.put('a');
      lettersCountedSet.put('c');

      // big int with format tag
      const bigIntBytes = new Uint8Array(32);
      bigIntBytes.fill(42); // deterministic bytes
      moment.put('big-number', new Bytes(bigIntBytes, new TextEncoder().encode('bi')));

      // long text using writer
      const longTextCursor = moment.putCursor('long-text');
      const cursorWriter = longTextCursor.writer();
      for (let i = 0; i < 50; i++) {
        cursorWriter.write(new TextEncoder().encode('hello, world\n'));
      }
      cursorWriter.finish();
    });

    // Verify first transaction
    const momentCursor = history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    const fooCursor = moment.getCursor('foo');
    const fooValue = fooCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(fooValue)).toBe('foo');

    expect((moment.getSlot('foo'))?.tag).toBe(Tag.SHORT_BYTES);
    expect((moment.getSlot('bar'))?.tag).toBe(Tag.SHORT_BYTES);

    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(fruits.count()).toBe(3);

    const appleCursor = fruits.getCursor(0);
    const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(appleValue)).toBe('apple');

    const peopleCursor = moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    expect(people.count()).toBe(2);

    const aliceCursor = people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = alice.getCursor('age');
    expect(aliceAgeCursor!.readUint()).toBe(25);

    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(todos.count()).toBe(3);

    const todoCursor = todos.getCursor(0);
    const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(todoValue)).toBe('Pay the bills');

    // iterate over people
    const peopleIter = people.iterator();
    while (peopleIter.hasNext()) {
      const personCursor = peopleIter.next();
      const person = new ReadHashMap(personCursor!);
      const personIter = person.iterator();
      while (personIter.hasNext()) {
        const kvPairCursor = personIter.next();
        const kvPair = kvPairCursor!.readKeyValuePair();
        kvPair.keyCursor.readBytes(MAX_READ_BYTES);

        switch (kvPair.valueCursor.slot().tag) {
          case Tag.SHORT_BYTES:
          case Tag.BYTES:
            kvPair.valueCursor.readBytes(MAX_READ_BYTES);
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
    const fruitsIter = fruits.iterator();
    while (fruitsIter.hasNext()) {
      fruitsIter.next();
    }

    // Counted hash map
    {
      const lettersCountedMapCursor = moment.getCursor('letters-counted-map');
      const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
      expect(lettersCountedMap.count()).toBe(2);

      const iter = lettersCountedMap.iterator();
      let count = 0;
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        const kvPair = kvPairCursor!.readKeyValuePair();
        kvPair.keyCursor.readBytes(MAX_READ_BYTES);
        count += 1;
      }
      expect(count).toBe(2);
    }

    // Hash set
    {
      const lettersSetCursor = moment.getCursor('letters-set');
      const lettersSet = new ReadHashSet(lettersSetCursor!);
      expect(lettersSet.getCursor('a')).not.toBeNull();
      expect(lettersSet.getCursor('c')).not.toBeNull();

      const iter = lettersSet.iterator();
      let count = 0;
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        const kvPair = kvPairCursor!.readKeyValuePair();
        kvPair.keyCursor.readBytes(MAX_READ_BYTES);
        count += 1;
      }
      expect(count).toBe(2);
    }

    // Counted hash set
    {
      const lettersCountedSetCursor = moment.getCursor('letters-counted-set');
      const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
      expect(lettersCountedSet.count()).toBe(2);

      const iter = lettersCountedSet.iterator();
      let count = 0;
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        const kvPair = kvPairCursor!.readKeyValuePair();
        kvPair.keyCursor.readBytes(MAX_READ_BYTES);
        count += 1;
      }
      expect(count).toBe(2);
    }

    // big number with format tag
    {
      const bigNumberCursor = moment.getCursor('big-number');
      const bigNumber = bigNumberCursor!.readBytesObject(MAX_READ_BYTES);
      expect(bigNumber.value.length).toBe(32);
      expect(bigNumber.value[0]).toBe(42);
      expect(new TextDecoder().decode(bigNumber.formatTag!)).toBe('bi');
    }

    // long text
    {
      const longTextCursor = moment.getCursor('long-text');
      const cursorReader = longTextCursor!.reader();
      let lineCount = 0, line: number[] = [];
      const buf = new Uint8Array(1024);
      for (let n; (n = cursorReader.read(buf)) > 0; ) {
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
    const history = new WriteArrayList(db.rootCursor());
    history.appendContext(history.getSlot(-1), (cursor) => {
      const moment = new WriteHashMap(cursor);

      expect(moment.remove('bar')).toBe(true);
      expect(moment.remove("doesn't exist")).toBe(false);

      const fruitsCursor = moment.putCursor('fruits');
      const fruits = new WriteArrayList(fruitsCursor);
      fruits.put(0, new Bytes('lemon'));
      fruits.slice(2);

      const peopleCursor = moment.putCursor('people');
      const people = new WriteArrayList(peopleCursor);
      const aliceCursor = people.putCursor(0);
      const alice = new WriteHashMap(aliceCursor);
      alice.put('age', new Uint(26));

      const todosCursor = moment.putCursor('todos');
      const todos = new WriteLinkedArrayList(todosCursor);
      todos.concat(todosCursor.slot());
      todos.slice(1, 2);
      todos.remove(1);

      const lettersCountedMapCursor = moment.putCursor('letters-counted-map');
      const lettersCountedMap = new WriteCountedHashMap(lettersCountedMapCursor);
      lettersCountedMap.remove('b');
      lettersCountedMap.remove('c');

      const lettersSetCursor = moment.putCursor('letters-set');
      const lettersSet = new WriteHashSet(lettersSetCursor);
      lettersSet.remove('b');
      lettersSet.remove('c');

      const lettersCountedSetCursor = moment.putCursor('letters-counted-set');
      const lettersCountedSet = new WriteCountedHashSet(lettersCountedSetCursor);
      lettersCountedSet.remove('b');
      lettersCountedSet.remove('c');
    });

    // Verify second transaction
    const momentCursor = history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    expect(moment.getCursor('bar')).toBeNull();

    const fruitsKeyCursor = moment.getKeyCursor('fruits');
    const fruitsKeyValue = fruitsKeyCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(fruitsKeyValue)).toBe('fruits');

    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(fruits.count()).toBe(2);

    const fruitsKVCursor = moment.getKeyValuePair('fruits');
    expect(fruitsKVCursor!.keyCursor.slotPtr.slot.tag).toBe(Tag.SHORT_BYTES);
    expect(fruitsKVCursor!.valueCursor.slotPtr.slot.tag).toBe(Tag.ARRAY_LIST);

    const lemonCursor = fruits.getCursor(0);
    const lemonValue = lemonCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(lemonValue)).toBe('lemon');

    const peopleCursor = moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    expect(people.count()).toBe(2);

    const aliceCursor = people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = alice.getCursor('age');
    expect(aliceAgeCursor!.readUint()).toBe(26);

    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(todos.count()).toBe(1);

    const todoCursor = todos.getCursor(0);
    const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(todoValue)).toBe('Wash the car');

    const lettersCountedMapCursor = moment.getCursor('letters-counted-map');
    const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
    expect(lettersCountedMap.count()).toBe(1);

    const lettersSetCursor = moment.getCursor('letters-set');
    const lettersSet = new ReadHashSet(lettersSetCursor!);
    expect(lettersSet.getCursor('a')).not.toBeNull();
    expect(lettersSet.getCursor('c')).toBeNull();

    const lettersCountedSetCursor = moment.getCursor('letters-counted-set');
    const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
    expect(lettersCountedSet.count()).toBe(1);
  }

  // The old data hasn't changed
  {
    const history = new WriteArrayList(db.rootCursor());
    const momentCursor = history.getCursor(0);
    const moment = new ReadHashMap(momentCursor!);

    const fooCursor = moment.getCursor('foo');
    const fooValue = fooCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(fooValue)).toBe('foo');

    expect((moment.getSlot('foo'))?.tag).toBe(Tag.SHORT_BYTES);
    expect((moment.getSlot('bar'))?.tag).toBe(Tag.SHORT_BYTES);

    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(fruits.count()).toBe(3);

    const appleCursor = fruits.getCursor(0);
    const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(appleValue)).toBe('apple');

    const peopleCursor = moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    expect(people.count()).toBe(2);

    const aliceCursor = people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = alice.getCursor('age');
    expect(aliceAgeCursor!.readUint()).toBe(25);

    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(todos.count()).toBe(3);

    const todoCursor = todos.getCursor(0);
    const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(todoValue)).toBe('Pay the bills');
  }

  // Remove the last transaction with slice
  {
    const history = new WriteArrayList(db.rootCursor());
    history.slice(1);

    const momentCursor = history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    const fooCursor = moment.getCursor('foo');
    const fooValue = fooCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(fooValue)).toBe('foo');

    expect((moment.getSlot('foo'))?.tag).toBe(Tag.SHORT_BYTES);
    expect((moment.getSlot('bar'))?.tag).toBe(Tag.SHORT_BYTES);

    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(fruits.count()).toBe(3);

    const appleCursor = fruits.getCursor(0);
    const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(appleValue)).toBe('apple');

    const peopleCursor = moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    expect(people.count()).toBe(2);

    const aliceCursor = people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = alice.getCursor('age');
    expect(aliceAgeCursor!.readUint()).toBe(25);

    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(todos.count()).toBe(3);

    const todoCursor = todos.getCursor(0);
    const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
    expect(new TextDecoder().decode(todoValue)).toBe('Pay the bills');
  }

  // The db size remains the same after writing junk data and then reinitializing the db
  {
    core.seek(core.length());
    const sizeBefore = core.length();

    const writer = core.writer();
    writer.write(new TextEncoder().encode('this is junk data that will be deleted during init'));

    db = new Database(core, hasher);

    const sizeAfter = core.length();
    expect(sizeBefore).toBe(sizeAfter);
  }

  // Cloning
  {
    const history = new WriteArrayList(db.rootCursor());
    history.appendContext(history.getSlot(-1), (cursor) => {
      const moment = new WriteHashMap(cursor);

      const fruitsCursor = moment.getCursor('fruits');
      const fruits = new ReadArrayList(fruitsCursor!);

      // create a new key called "food" whose initial value is based on the "fruits" list
      const foodCursor = moment.putCursor('food');
      foodCursor.write(fruits.slot());

      const food = new WriteArrayList(foodCursor);
      food.append(new Bytes('eggs'));
      food.append(new Bytes('rice'));
      food.append(new Bytes('fish'));
    });

    const momentCursor = history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    // the food list includes the fruits
    const foodCursor = moment.getCursor('food');
    const food = new ReadArrayList(foodCursor!);
    expect(food.count()).toBe(6);

    // ...but the fruits list hasn't been changed
    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(fruits.count()).toBe(3);
  }

  // Accidental mutation when cloning inside a transaction
  {
    const history = new WriteArrayList(db.rootCursor());
    const historyIndex = (history.count()) - 1;

    history.appendContext(history.getSlot(-1), (cursor) => {
      const moment = new WriteHashMap(cursor);

      const bigCitiesCursor = moment.putCursor('big-cities');
      const bigCities = new WriteArrayList(bigCitiesCursor);
      bigCities.append(new Bytes('New York, NY'));
      bigCities.append(new Bytes('Los Angeles, CA'));

      // create a new key called "cities" whose initial value is based on the "big-cities" list
      const citiesCursor = moment.putCursor('cities');
      citiesCursor.write(bigCities.slot());

      const cities = new WriteArrayList(citiesCursor);
      cities.append(new Bytes('Charleston, SC'));
      cities.append(new Bytes('Louisville, KY'));
    });

    const momentCursor = history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    // the cities list contains all four
    const citiesCursor = moment.getCursor('cities');
    const cities = new ReadArrayList(citiesCursor!);
    expect(cities.count()).toBe(4);

    // ..but so does big-cities! we did not intend to mutate this
    const bigCitiesCursor = moment.getCursor('big-cities');
    const bigCities = new ReadArrayList(bigCitiesCursor!);
    expect(bigCities.count()).toBe(4);

    // revert that change
    history.append((history.getSlot(historyIndex))!);
  }

  // Preventing accidental mutation with freezing
  {
    const history = new WriteArrayList(db.rootCursor());
    history.appendContext(history.getSlot(-1), (cursor) => {
      const moment = new WriteHashMap(cursor);

      const bigCitiesCursor = moment.putCursor('big-cities');
      const bigCities = new WriteArrayList(bigCitiesCursor);
      bigCities.append(new Bytes('New York, NY'));
      bigCities.append(new Bytes('Los Angeles, CA'));

      // freeze here, so big-cities won't be mutated
      cursor.db.freeze();

      // create a new key called "cities" whose initial value is based on the "big-cities" list
      const citiesCursor = moment.putCursor('cities');
      citiesCursor.write(bigCities.slot());

      const cities = new WriteArrayList(citiesCursor);
      cities.append(new Bytes('Charleston, SC'));
      cities.append(new Bytes('Louisville, KY'));
    });

    const momentCursor = history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    // the cities list contains all four
    const citiesCursor = moment.getCursor('cities');
    const cities = new ReadArrayList(citiesCursor!);
    expect(cities.count()).toBe(4);

    // and big-cities only contains the original two
    const bigCitiesCursor = moment.getCursor('big-cities');
    const bigCities = new ReadArrayList(bigCitiesCursor!);
    expect(bigCities.count()).toBe(2);
  }
}

describe('Compaction', () => {
  test('in-memory storage', () => {
    const sourceCore = new CoreMemory();
    const targetCore = new CoreMemory();
    const hasher = new Hasher('SHA-1');
    testCompaction(sourceCore, targetCore, hasher, null, null);
  });

  test('file storage', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xitdb-compact-'));
    const sourcePath = join(tmpDir, 'source.db');
    const targetPath = join(tmpDir, 'target.db');
    try {
      using sourceCore = new CoreFile(sourcePath);
      using targetCore = new CoreFile(targetPath);
      const hasher = new Hasher('SHA-1');
      testCompaction(sourceCore, targetCore, hasher, sourcePath, targetPath);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('buffered file storage', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xitdb-compact-'));
    const sourcePath = join(tmpDir, 'source.db');
    const targetPath = join(tmpDir, 'target.db');
    try {
      using sourceCore = new CoreBufferedFile(sourcePath);
      using targetCore = new CoreBufferedFile(targetPath);
      const hasher = new Hasher('SHA-1');
      testCompaction(sourceCore, targetCore, hasher, sourcePath, targetPath);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('buffered file to in-memory storage', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xitdb-compact-'));
    const sourcePath = join(tmpDir, 'source.db');
    try {
      using sourceCore = new CoreBufferedFile(sourcePath);
      const targetCore = new CoreMemory();
      const hasher = new Hasher('SHA-1');
      testCompaction(sourceCore, targetCore, hasher, sourcePath, null);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

function testCompaction(
  sourceCore: Core,
  targetCore: Core,
  hasher: Hasher,
  sourcePath: string | null,
  targetPath: string | null
): void {
  const decoder = new TextDecoder();

  // empty DB compaction
  {
    sourceCore.setLength(0);
    targetCore.setLength(0);
    const source = new Database(sourceCore, hasher);
    const compacted = source.compact(targetCore);
    expect(compacted.header.tag).toBe(Tag.NONE);
  }

  // basic compaction with various data types
  {
    sourceCore.setLength(0);
    targetCore.setLength(0);
    const source = new Database(sourceCore, hasher);

    // moment 1
    {
      const history = new WriteArrayList(source.rootCursor());
      history.appendContext(history.getSlot(-1), (cursor) => {
        const moment = new WriteHashMap(cursor);
        moment.put('key1', new Bytes('value1'));
        moment.put('key2', new Uint(100));
      });
    }

    // moment 2
    {
      const history = new WriteArrayList(source.rootCursor());
      history.appendContext(history.getSlot(-1), (cursor) => {
        const moment = new WriteHashMap(cursor);
        moment.put('key1', new Bytes('updated_value1'));
        moment.put('key2', new Uint(200));
        moment.put('key3', new Int(-42));
        moment.put('key4', new Float(3.14));
        moment.put('short', new Bytes('hi'));

        // long bytes with format_tag
        moment.put('tagged', new Bytes(
          new TextEncoder().encode('this is a long tagged string!!'),
          new TextEncoder().encode('bi')
        ));

        // ArrayList
        const fruitsCursor = moment.putCursor('fruits');
        const fruits = new WriteArrayList(fruitsCursor);
        fruits.append(new Bytes('apple'));
        fruits.append(new Bytes('banana'));
        fruits.append(new Bytes('cherry'));

        // LinkedArrayList
        const todosCursor = moment.putCursor('todos');
        const todos = new WriteLinkedArrayList(todosCursor);
        todos.append(new Bytes('task1'));
        todos.append(new Bytes('task2'));
        todos.append(new Bytes('task3'));

        // CountedHashMap
        const countedCursor = moment.putCursor('counted');
        const counted = new WriteCountedHashMap(countedCursor);
        counted.put('a', new Uint(1));
        counted.putKey('a', new Bytes('a'));
        counted.put('b', new Uint(2));
        counted.putKey('b', new Bytes('b'));

        // HashSet
        const setCursor = moment.putCursor('myset');
        const set = new WriteHashSet(setCursor);
        set.put('x');
        set.put('y');

        // CountedHashSet
        const csetCursor = moment.putCursor('mycset');
        const cset = new WriteCountedHashSet(csetCursor);
        cset.put('p');
        cset.put('q');
      });
    }

    // moment 3
    {
      const history = new WriteArrayList(source.rootCursor());
      history.appendContext(history.getSlot(-1), (cursor) => {
        const moment = new WriteHashMap(cursor);
        moment.put('key1', new Bytes('final_value'));
      });
    }

    const sourceSize = sourceCore.length();

    // compact
    const compacted = source.compact(targetCore);

    const targetSize = targetCore.length();

    // target should be smaller than source (3 moments vs 1)
    expect(targetSize).toBeLessThan(sourceSize);

    // target should have exactly 1 moment
    const history = new ReadArrayList(compacted.rootCursor());
    expect(history.count()).toBe(1);

    // verify all data from latest moment is correct
    const momentCursor = history.getCursor(0);
    const moment = new ReadHashMap(momentCursor!);

    // key1 should have the final value
    expect(decoder.decode((moment.getCursor('key1'))!.readBytes(MAX_READ_BYTES))).toBe('final_value');

    // key2 from moment 2
    expect((moment.getCursor('key2'))!.readUint()).toBe(200);

    // key3 - int
    expect((moment.getCursor('key3'))!.readInt()).toBe(-42);

    // key4 - float
    expect((moment.getCursor('key4'))!.readFloat()).toBe(3.14);

    // short bytes
    expect(decoder.decode((moment.getCursor('short'))!.readBytes(MAX_READ_BYTES))).toBe('hi');

    // tagged bytes
    const taggedObj = (moment.getCursor('tagged'))!.readBytesObject(MAX_READ_BYTES);
    expect(decoder.decode(taggedObj.value)).toBe('this is a long tagged string!!');
    expect(decoder.decode(taggedObj.formatTag!)).toBe('bi');

    // ArrayList
    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    expect(fruits.count()).toBe(3);
    expect(decoder.decode((fruits.getCursor(0))!.readBytes(MAX_READ_BYTES))).toBe('apple');
    expect(decoder.decode((fruits.getCursor(2))!.readBytes(MAX_READ_BYTES))).toBe('cherry');

    // LinkedArrayList
    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    expect(todos.count()).toBe(3);
    expect(decoder.decode((todos.getCursor(0))!.readBytes(MAX_READ_BYTES))).toBe('task1');
    expect(decoder.decode((todos.getCursor(2))!.readBytes(MAX_READ_BYTES))).toBe('task3');

    // CountedHashMap
    const countedCursor = moment.getCursor('counted');
    const counted = new ReadCountedHashMap(countedCursor!);
    expect(counted.count()).toBe(2);
    expect((counted.getCursor('a'))!.readUint()).toBe(1);
    expect((counted.getCursor('b'))!.readUint()).toBe(2);

    // HashSet
    const setCursor = moment.getCursor('myset');
    const set = new ReadHashSet(setCursor!);
    expect(decoder.decode((set.getCursor('x'))!.readBytes(MAX_READ_BYTES))).toBe('x');

    // CountedHashSet
    const csetCursor = moment.getCursor('mycset');
    const cset = new ReadCountedHashSet(csetCursor!);
    expect(cset.count()).toBe(2);
    expect(decoder.decode((cset.getCursor('p'))!.readBytes(MAX_READ_BYTES))).toBe('p');
  }

  // structural sharing (most data shared, only 1 key changes per moment)
  {
    sourceCore.setLength(0);
    targetCore.setLength(0);
    const source = new Database(sourceCore, hasher);

    // moment 1: create many keys
    {
      const history = new WriteArrayList(source.rootCursor());
      history.appendContext(history.getSlot(-1), (cursor) => {
        const moment = new WriteHashMap(cursor);
        for (let i = 0; i < 20; i++) {
          moment.put(`shared_key_${i}`, new Uint(i));
        }
      });
    }

    // moments 2-5: change only one key each time
    for (let round = 0; round < 4; round++) {
      const history = new WriteArrayList(source.rootCursor());
      history.appendContext(history.getSlot(-1), (cursor) => {
        const moment = new WriteHashMap(cursor);
        moment.put('changing_key', new Uint(round + 100));
      });
    }

    const compacted = source.compact(targetCore);

    const history = new ReadArrayList(compacted.rootCursor());
    expect(history.count()).toBe(1);

    const momentCursor = history.getCursor(0);
    const moment = new ReadHashMap(momentCursor!);

    // verify shared keys are intact
    for (let i = 0; i < 20; i++) {
      expect((moment.getCursor(`shared_key_${i}`))!.readUint()).toBe(i);
    }

    // verify changing key has latest value
    expect((moment.getCursor('changing_key'))!.readUint()).toBe(103);
  }

  // re-open after compact and compact-then-continue-writing
  // (only meaningful for file modes)
  if (sourcePath !== null && targetPath !== null) {
    // re-open after compact
    {
      sourceCore.setLength(0);
      targetCore.setLength(0);
      const source = new Database(sourceCore, hasher);

      // write some data
      {
        const history = new WriteArrayList(source.rootCursor());
        history.appendContext(history.getSlot(-1), (cursor) => {
          const moment = new WriteHashMap(cursor);
          moment.put('persist', new Bytes('persistent_value'));
          moment.put('number', new Uint(999));
        });
      }

      // compact
      source.compact(targetCore);

      // re-open the target
      targetCore.seek(0);
      const reopened = new Database(targetCore, hasher);

      const history = new ReadArrayList(reopened.rootCursor());
      expect(history.count()).toBe(1);

      const momentCursor = history.getCursor(0);
      const moment = new ReadHashMap(momentCursor!);
      expect(decoder.decode((moment.getCursor('persist'))!.readBytes(MAX_READ_BYTES))).toBe('persistent_value');
      expect((moment.getCursor('number'))!.readUint()).toBe(999);
    }

    // compact then continue writing
    {
      sourceCore.setLength(0);
      targetCore.setLength(0);
      const source = new Database(sourceCore, hasher);

      // write initial data
      {
        const history = new WriteArrayList(source.rootCursor());
        history.appendContext(history.getSlot(-1), (cursor) => {
          const moment = new WriteHashMap(cursor);
          moment.put('original', new Bytes('original_data'));
        });
      }

      // compact
      const compacted = source.compact(targetCore);

      // add new moment to compacted DB
      {
        const history = new WriteArrayList(compacted.rootCursor());
        history.appendContext(history.getSlot(-1), (cursor) => {
          const moment = new WriteHashMap(cursor);
          moment.put('new_key', new Bytes('new_data'));
        });
      }

      // verify both old and new data
      const history = new ReadArrayList(compacted.rootCursor());
      expect(history.count()).toBe(2);

      // moment 0 (compacted original)
      const m0Cursor = history.getCursor(0);
      const m0 = new ReadHashMap(m0Cursor!);
      expect(decoder.decode((m0.getCursor('original'))!.readBytes(MAX_READ_BYTES))).toBe('original_data');

      // moment 1 (new data added after compact)
      const m1Cursor = history.getCursor(1);
      const m1 = new ReadHashMap(m1Cursor!);
      expect(decoder.decode((m1.getCursor('new_key'))!.readBytes(MAX_READ_BYTES))).toBe('new_data');

      // original data should still be in moment 1 (inherited)
      expect(decoder.decode((m1.getCursor('original'))!.readBytes(MAX_READ_BYTES))).toBe('original_data');
    }
  }
}
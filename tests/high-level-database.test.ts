import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
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
  ReadSortedMap,
  WriteSortedMap,
  ReadSortedSet,
  WriteSortedSet,
  Bytes,
  Uint,
  Int,
  Float,
  Slot,
  SlotPointer,
  ReadCursor,
  WriteCursor,
  SortedMapGet,
  SortedMapGetIndex,
  SortedMapGetKey,
  WriteData,
  InvalidTopLevelTypeException,
  WriteNotAllowedException,
  CursorNotWriteableException,
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

      assert.throws(() => new WriteLinkedArrayList(db.rootCursor()), InvalidTopLevelTypeException);
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
      assert.notStrictEqual(momentCursor, null);
      const moment = new ReadHashMap(momentCursor!);

      const fooCursor = moment.getCursor('foo');
      assert.notStrictEqual(fooCursor, null);
      const fooValue = fooCursor!.readBytes(MAX_READ_BYTES);
      assert.strictEqual(new TextDecoder().decode(fooValue), 'foo');

      const fooSlot = moment.getSlot('foo');
      assert.strictEqual(fooSlot?.tag, Tag.SHORT_BYTES);
      const barSlot = moment.getSlot('bar');
      assert.strictEqual(barSlot?.tag, Tag.SHORT_BYTES);

      const fruitsCursor = moment.getCursor('fruits');
      assert.notStrictEqual(fruitsCursor, null);
      const fruits = new ReadArrayList(fruitsCursor!);
      assert.strictEqual(fruits.count(), 3);

      const appleCursor = fruits.getCursor(0);
      assert.notStrictEqual(appleCursor, null);
      const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
      assert.strictEqual(new TextDecoder().decode(appleValue), 'apple');

      const peopleCursor = moment.getCursor('people');
      assert.notStrictEqual(peopleCursor, null);
      const people = new ReadArrayList(peopleCursor!);
      assert.strictEqual(people.count(), 2);

      const aliceCursor = people.getCursor(0);
      assert.notStrictEqual(aliceCursor, null);
      const alice = new ReadHashMap(aliceCursor!);
      const aliceAgeCursor = alice.getCursor('age');
      assert.notStrictEqual(aliceAgeCursor, null);
      assert.strictEqual(aliceAgeCursor!.readUint(), 25);

      const todosCursor = moment.getCursor('todos');
      assert.notStrictEqual(todosCursor, null);
      const todos = new ReadLinkedArrayList(todosCursor!);
      assert.strictEqual(todos.count(), 3);

      const todoCursor = todos.getCursor(0);
      assert.notStrictEqual(todoCursor, null);
      const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
      assert.strictEqual(new TextDecoder().decode(todoValue), 'Pay the bills');

      // Test iterating over people
      const peopleIter = people.iterator();
      while (peopleIter.hasNext()) {
        const personCursor = peopleIter.next();
        assert.notStrictEqual(personCursor, null);
        const person = new ReadHashMap(personCursor!);
        const personIter = person.iterator();
        while (personIter.hasNext()) {
          const kvPairCursor = personIter.next();
          assert.notStrictEqual(kvPairCursor, null);
          kvPairCursor!.readKeyValuePair();
        }
      }

      // Counted hash map
      {
        const lettersCountedMapCursor = moment.getCursor('letters-counted-map');
        assert.notStrictEqual(lettersCountedMapCursor, null);
        const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
        assert.strictEqual(lettersCountedMap.count(), 2);

        const iter = lettersCountedMap.iterator();
        let count = 0;
        while (iter.hasNext()) {
          const kvPairCursor = iter.next();
          assert.notStrictEqual(kvPairCursor, null);
          const kvPair = kvPairCursor!.readKeyValuePair();
          kvPair.keyCursor.readBytes(MAX_READ_BYTES);
          count += 1;
        }
        assert.strictEqual(count, 2);
      }

      // Hash set
      {
        const lettersSetCursor = moment.getCursor('letters-set');
        assert.notStrictEqual(lettersSetCursor, null);
        const lettersSet = new ReadHashSet(lettersSetCursor!);
        assert.notStrictEqual(lettersSet.getCursor('a'), null);
        assert.notStrictEqual(lettersSet.getCursor('c'), null);

        const iter = lettersSet.iterator();
        let count = 0;
        while (iter.hasNext()) {
          const kvPairCursor = iter.next();
          assert.notStrictEqual(kvPairCursor, null);
          const kvPair = kvPairCursor!.readKeyValuePair();
          kvPair.keyCursor.readBytes(MAX_READ_BYTES);
          count += 1;
        }
        assert.strictEqual(count, 2);
      }

      // Counted hash set
      {
        const lettersCountedSetCursor = moment.getCursor('letters-counted-set');
        assert.notStrictEqual(lettersCountedSetCursor, null);
        const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
        assert.strictEqual(lettersCountedSet.count(), 2);

        const iter = lettersCountedSet.iterator();
        let count = 0;
        while (iter.hasNext()) {
          const kvPairCursor = iter.next();
          assert.notStrictEqual(kvPairCursor, null);
          const kvPair = kvPairCursor!.readKeyValuePair();
          kvPair.keyCursor.readBytes(MAX_READ_BYTES);
          count += 1;
        }
        assert.strictEqual(count, 2);
      }
    }

    // Second moment
    {
      const momentCursor = history.getCursor(1);
      assert.notStrictEqual(momentCursor, null);
      const moment = new ReadHashMap(momentCursor!);

      assert.strictEqual(moment.getCursor('bar'), null);

      const fruitsKeyCursor = moment.getKeyCursor('fruits');
      assert.notStrictEqual(fruitsKeyCursor, null);
      const fruitsKeyValue = fruitsKeyCursor!.readBytes(MAX_READ_BYTES);
      assert.strictEqual(new TextDecoder().decode(fruitsKeyValue), 'fruits');

      const fruitsCursor = moment.getCursor('fruits');
      assert.notStrictEqual(fruitsCursor, null);
      const fruits = new ReadArrayList(fruitsCursor!);
      assert.strictEqual(fruits.count(), 2);

      const fruitsKVCursor = moment.getKeyValuePair('fruits');
      assert.notStrictEqual(fruitsKVCursor, null);
      assert.strictEqual(fruitsKVCursor!.keyCursor.slotPtr.slot.tag, Tag.SHORT_BYTES);
      assert.strictEqual(fruitsKVCursor!.valueCursor.slotPtr.slot.tag, Tag.ARRAY_LIST);

      const lemonCursor = fruits.getCursor(0);
      assert.notStrictEqual(lemonCursor, null);
      const lemonValue = lemonCursor!.readBytes(MAX_READ_BYTES);
      assert.strictEqual(new TextDecoder().decode(lemonValue), 'lemon');

      const peopleCursor = moment.getCursor('people');
      assert.notStrictEqual(peopleCursor, null);
      const people = new ReadArrayList(peopleCursor!);
      assert.strictEqual(people.count(), 2);

      const aliceCursor = people.getCursor(0);
      assert.notStrictEqual(aliceCursor, null);
      const alice = new ReadHashMap(aliceCursor!);
      const aliceAgeCursor = alice.getCursor('age');
      assert.notStrictEqual(aliceAgeCursor, null);
      assert.strictEqual(aliceAgeCursor!.readUint(), 26);

      const todosCursor = moment.getCursor('todos');
      assert.notStrictEqual(todosCursor, null);
      const todos = new ReadLinkedArrayList(todosCursor!);
      assert.strictEqual(todos.count(), 1);

      const todoCursor = todos.getCursor(0);
      assert.notStrictEqual(todoCursor, null);
      const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
      assert.strictEqual(new TextDecoder().decode(todoValue), 'Wash the car');

      const lettersCountedMapCursor = moment.getCursor('letters-counted-map');
      assert.notStrictEqual(lettersCountedMapCursor, null);
      const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
      assert.strictEqual(lettersCountedMap.count(), 1);

      const lettersSetCursor = moment.getCursor('letters-set');
      assert.notStrictEqual(lettersSetCursor, null);
      const lettersSet = new ReadHashSet(lettersSetCursor!);
      assert.notStrictEqual(lettersSet.getCursor('a'), null);
      assert.strictEqual(lettersSet.getCursor('c'), null);

      const lettersCountedSetCursor = moment.getCursor('letters-counted-set');
      assert.notStrictEqual(lettersCountedSetCursor, null);
      const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
      assert.strictEqual(lettersCountedSet.count(), 1);
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
    assert.strictEqual(new TextDecoder().decode(fooValue), 'foo');

    assert.strictEqual((moment.getSlot('foo'))?.tag, Tag.SHORT_BYTES);
    assert.strictEqual((moment.getSlot('bar'))?.tag, Tag.SHORT_BYTES);

    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    assert.strictEqual(fruits.count(), 3);

    const appleCursor = fruits.getCursor(0);
    const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(appleValue), 'apple');

    const peopleCursor = moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    assert.strictEqual(people.count(), 2);

    const aliceCursor = people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = alice.getCursor('age');
    assert.strictEqual(aliceAgeCursor!.readUint(), 25);

    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    assert.strictEqual(todos.count(), 3);

    const todoCursor = todos.getCursor(0);
    const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(todoValue), 'Pay the bills');

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
      assert.strictEqual(lettersCountedMap.count(), 2);

      const iter = lettersCountedMap.iterator();
      let count = 0;
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        const kvPair = kvPairCursor!.readKeyValuePair();
        kvPair.keyCursor.readBytes(MAX_READ_BYTES);
        count += 1;
      }
      assert.strictEqual(count, 2);
    }

    // Hash set
    {
      const lettersSetCursor = moment.getCursor('letters-set');
      const lettersSet = new ReadHashSet(lettersSetCursor!);
      assert.notStrictEqual(lettersSet.getCursor('a'), null);
      assert.notStrictEqual(lettersSet.getCursor('c'), null);

      const iter = lettersSet.iterator();
      let count = 0;
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        const kvPair = kvPairCursor!.readKeyValuePair();
        kvPair.keyCursor.readBytes(MAX_READ_BYTES);
        count += 1;
      }
      assert.strictEqual(count, 2);
    }

    // Counted hash set
    {
      const lettersCountedSetCursor = moment.getCursor('letters-counted-set');
      const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
      assert.strictEqual(lettersCountedSet.count(), 2);

      const iter = lettersCountedSet.iterator();
      let count = 0;
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        const kvPair = kvPairCursor!.readKeyValuePair();
        kvPair.keyCursor.readBytes(MAX_READ_BYTES);
        count += 1;
      }
      assert.strictEqual(count, 2);
    }

    // big number with format tag
    {
      const bigNumberCursor = moment.getCursor('big-number');
      const bigNumber = bigNumberCursor!.readBytesObject(MAX_READ_BYTES);
      assert.strictEqual(bigNumber.value.length, 32);
      assert.strictEqual(bigNumber.value[0], 42);
      assert.strictEqual(new TextDecoder().decode(bigNumber.formatTag!), 'bi');
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
      assert.strictEqual(lineCount, 50);
    }
  }

  // Second transaction - modify data
  {
    const history = new WriteArrayList(db.rootCursor());
    history.appendContext(history.getSlot(-1), (cursor) => {
      const moment = new WriteHashMap(cursor);

      assert.strictEqual(moment.remove('bar'), true);
      assert.strictEqual(moment.remove("doesn't exist"), false);

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

    assert.strictEqual(moment.getCursor('bar'), null);

    const fruitsKeyCursor = moment.getKeyCursor('fruits');
    const fruitsKeyValue = fruitsKeyCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(fruitsKeyValue), 'fruits');

    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    assert.strictEqual(fruits.count(), 2);

    const fruitsKVCursor = moment.getKeyValuePair('fruits');
    assert.strictEqual(fruitsKVCursor!.keyCursor.slotPtr.slot.tag, Tag.SHORT_BYTES);
    assert.strictEqual(fruitsKVCursor!.valueCursor.slotPtr.slot.tag, Tag.ARRAY_LIST);

    const lemonCursor = fruits.getCursor(0);
    const lemonValue = lemonCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(lemonValue), 'lemon');

    const peopleCursor = moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    assert.strictEqual(people.count(), 2);

    const aliceCursor = people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = alice.getCursor('age');
    assert.strictEqual(aliceAgeCursor!.readUint(), 26);

    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    assert.strictEqual(todos.count(), 1);

    const todoCursor = todos.getCursor(0);
    const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(todoValue), 'Wash the car');

    const lettersCountedMapCursor = moment.getCursor('letters-counted-map');
    const lettersCountedMap = new ReadCountedHashMap(lettersCountedMapCursor!);
    assert.strictEqual(lettersCountedMap.count(), 1);

    const lettersSetCursor = moment.getCursor('letters-set');
    const lettersSet = new ReadHashSet(lettersSetCursor!);
    assert.notStrictEqual(lettersSet.getCursor('a'), null);
    assert.strictEqual(lettersSet.getCursor('c'), null);

    const lettersCountedSetCursor = moment.getCursor('letters-counted-set');
    const lettersCountedSet = new ReadCountedHashSet(lettersCountedSetCursor!);
    assert.strictEqual(lettersCountedSet.count(), 1);
  }

  // The old data hasn't changed
  {
    const history = new WriteArrayList(db.rootCursor());
    const momentCursor = history.getCursor(0);
    const moment = new ReadHashMap(momentCursor!);

    const fooCursor = moment.getCursor('foo');
    const fooValue = fooCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(fooValue), 'foo');

    assert.strictEqual((moment.getSlot('foo'))?.tag, Tag.SHORT_BYTES);
    assert.strictEqual((moment.getSlot('bar'))?.tag, Tag.SHORT_BYTES);

    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    assert.strictEqual(fruits.count(), 3);

    const appleCursor = fruits.getCursor(0);
    const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(appleValue), 'apple');

    const peopleCursor = moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    assert.strictEqual(people.count(), 2);

    const aliceCursor = people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = alice.getCursor('age');
    assert.strictEqual(aliceAgeCursor!.readUint(), 25);

    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    assert.strictEqual(todos.count(), 3);

    const todoCursor = todos.getCursor(0);
    const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(todoValue), 'Pay the bills');
  }

  // Remove the last transaction with slice
  {
    const history = new WriteArrayList(db.rootCursor());
    history.slice(1);

    const momentCursor = history.getCursor(-1);
    const moment = new ReadHashMap(momentCursor!);

    const fooCursor = moment.getCursor('foo');
    const fooValue = fooCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(fooValue), 'foo');

    assert.strictEqual((moment.getSlot('foo'))?.tag, Tag.SHORT_BYTES);
    assert.strictEqual((moment.getSlot('bar'))?.tag, Tag.SHORT_BYTES);

    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    assert.strictEqual(fruits.count(), 3);

    const appleCursor = fruits.getCursor(0);
    const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(appleValue), 'apple');

    const peopleCursor = moment.getCursor('people');
    const people = new ReadArrayList(peopleCursor!);
    assert.strictEqual(people.count(), 2);

    const aliceCursor = people.getCursor(0);
    const alice = new ReadHashMap(aliceCursor!);
    const aliceAgeCursor = alice.getCursor('age');
    assert.strictEqual(aliceAgeCursor!.readUint(), 25);

    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    assert.strictEqual(todos.count(), 3);

    const todoCursor = todos.getCursor(0);
    const todoValue = todoCursor!.readBytes(MAX_READ_BYTES);
    assert.strictEqual(new TextDecoder().decode(todoValue), 'Pay the bills');
  }

  // The db size remains the same after writing junk data and then reinitializing the db
  {
    core.seek(core.length());
    const sizeBefore = core.length();

    const writer = core.writer();
    writer.write(new TextEncoder().encode('this is junk data that will be deleted during init'));

    db = new Database(core, hasher);

    const sizeAfter = core.length();
    assert.strictEqual(sizeBefore, sizeAfter);
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
    assert.strictEqual(food.count(), 6);

    // ...but the fruits list hasn't been changed
    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    assert.strictEqual(fruits.count(), 3);
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
    assert.strictEqual(cities.count(), 4);

    // ..but so does big-cities! we did not intend to mutate this
    const bigCitiesCursor = moment.getCursor('big-cities');
    const bigCities = new ReadArrayList(bigCitiesCursor!);
    assert.strictEqual(bigCities.count(), 4);

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
    assert.strictEqual(cities.count(), 4);

    // and big-cities only contains the original two
    const bigCitiesCursor = moment.getCursor('big-cities');
    const bigCities = new ReadArrayList(bigCitiesCursor!);
    assert.strictEqual(bigCities.count(), 2);
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
    assert.strictEqual(compacted.header.tag, Tag.NONE);
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

        // SortedMap
        const sorted = new WriteSortedMap(moment.putCursor('sorted'));
        sorted.put('apple', new Uint(1));
        sorted.put('banana', new Uint(2));
        sorted.put('cherry', new Uint(3));

        // SortedSet
        const sortedSet = new WriteSortedSet(moment.putCursor('sortedset'));
        sortedSet.put('foo');
        sortedSet.put('bar');
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
    assert.ok((targetSize) < (sourceSize));

    // target should have exactly 1 moment
    const history = new ReadArrayList(compacted.rootCursor());
    assert.strictEqual(history.count(), 1);

    // verify all data from latest moment is correct
    const momentCursor = history.getCursor(0);
    const moment = new ReadHashMap(momentCursor!);

    // key1 should have the final value
    assert.strictEqual(decoder.decode((moment.getCursor('key1'))!.readBytes(MAX_READ_BYTES)), 'final_value');

    // key2 from moment 2
    assert.strictEqual((moment.getCursor('key2'))!.readUint(), 200);

    // key3 - int
    assert.strictEqual((moment.getCursor('key3'))!.readInt(), -42);

    // key4 - float
    assert.strictEqual((moment.getCursor('key4'))!.readFloat(), 3.14);

    // short bytes
    assert.strictEqual(decoder.decode((moment.getCursor('short'))!.readBytes(MAX_READ_BYTES)), 'hi');

    // tagged bytes
    const taggedObj = (moment.getCursor('tagged'))!.readBytesObject(MAX_READ_BYTES);
    assert.strictEqual(decoder.decode(taggedObj.value), 'this is a long tagged string!!');
    assert.strictEqual(decoder.decode(taggedObj.formatTag!), 'bi');

    // ArrayList
    const fruitsCursor = moment.getCursor('fruits');
    const fruits = new ReadArrayList(fruitsCursor!);
    assert.strictEqual(fruits.count(), 3);
    assert.strictEqual(decoder.decode((fruits.getCursor(0))!.readBytes(MAX_READ_BYTES)), 'apple');
    assert.strictEqual(decoder.decode((fruits.getCursor(2))!.readBytes(MAX_READ_BYTES)), 'cherry');

    // LinkedArrayList
    const todosCursor = moment.getCursor('todos');
    const todos = new ReadLinkedArrayList(todosCursor!);
    assert.strictEqual(todos.count(), 3);
    assert.strictEqual(decoder.decode((todos.getCursor(0))!.readBytes(MAX_READ_BYTES)), 'task1');
    assert.strictEqual(decoder.decode((todos.getCursor(2))!.readBytes(MAX_READ_BYTES)), 'task3');

    // CountedHashMap
    const countedCursor = moment.getCursor('counted');
    const counted = new ReadCountedHashMap(countedCursor!);
    assert.strictEqual(counted.count(), 2);
    assert.strictEqual((counted.getCursor('a'))!.readUint(), 1);
    assert.strictEqual((counted.getCursor('b'))!.readUint(), 2);

    // HashSet
    const setCursor = moment.getCursor('myset');
    const set = new ReadHashSet(setCursor!);
    assert.strictEqual(decoder.decode((set.getCursor('x'))!.readBytes(MAX_READ_BYTES)), 'x');

    // CountedHashSet
    const csetCursor = moment.getCursor('mycset');
    const cset = new ReadCountedHashSet(csetCursor!);
    assert.strictEqual(cset.count(), 2);
    assert.strictEqual(decoder.decode((cset.getCursor('p'))!.readBytes(MAX_READ_BYTES)), 'p');

    // SortedMap
    const sorted = new ReadSortedMap(moment.getCursor('sorted')!);
    assert.strictEqual(sorted.count(), 3);
    assert.strictEqual(sorted.getCursor('banana')!.readUint(), 2);
    // lexicographic order is preserved across compaction
    assert.strictEqual(decoder.decode(sorted.getIndexKeyValuePair(0)!.keyCursor.readBytes(MAX_READ_BYTES)), 'apple');
    assert.strictEqual(decoder.decode(sorted.getIndexKeyValuePair(-1)!.keyCursor.readBytes(MAX_READ_BYTES)), 'cherry');

    // SortedSet
    const sortedSet = new ReadSortedSet(moment.getCursor('sortedset')!);
    assert.strictEqual(sortedSet.count(), 2);
    assert.ok(sortedSet.contains('foo'));
    assert.ok(sortedSet.contains('bar'));
    assert.ok(!sortedSet.contains('baz'));
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
    assert.strictEqual(history.count(), 1);

    const momentCursor = history.getCursor(0);
    const moment = new ReadHashMap(momentCursor!);

    // verify shared keys are intact
    for (let i = 0; i < 20; i++) {
      assert.strictEqual((moment.getCursor(`shared_key_${i}`))!.readUint(), i);
    }

    // verify changing key has latest value
    assert.strictEqual((moment.getCursor('changing_key'))!.readUint(), 103);
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
      assert.strictEqual(history.count(), 1);

      const momentCursor = history.getCursor(0);
      const moment = new ReadHashMap(momentCursor!);
      assert.strictEqual(decoder.decode((moment.getCursor('persist'))!.readBytes(MAX_READ_BYTES)), 'persistent_value');
      assert.strictEqual((moment.getCursor('number'))!.readUint(), 999);
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
      assert.strictEqual(history.count(), 2);

      // moment 0 (compacted original)
      const m0Cursor = history.getCursor(0);
      const m0 = new ReadHashMap(m0Cursor!);
      assert.strictEqual(decoder.decode((m0.getCursor('original'))!.readBytes(MAX_READ_BYTES)), 'original_data');

      // moment 1 (new data added after compact)
      const m1Cursor = history.getCursor(1);
      const m1 = new ReadHashMap(m1Cursor!);
      assert.strictEqual(decoder.decode((m1.getCursor('new_key'))!.readBytes(MAX_READ_BYTES)), 'new_data');

      // original data should still be in moment 1 (inherited)
      assert.strictEqual(decoder.decode((m1.getCursor('original'))!.readBytes(MAX_READ_BYTES)), 'original_data');
    }
  }
}
describe('Sorted Map', () => {
  test('in-memory storage', () => {
    const core = new CoreMemory();
    testSortedMap(core, new Hasher('SHA-1'));
  });

  test('file storage', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xitdb-'));
    try {
      using core = new CoreFile(join(tmpDir, 'test.db'));
      testSortedMap(core, new Hasher('SHA-1'));
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('buffered file storage', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'xitdb-'));
    try {
      using core = new CoreBufferedFile(join(tmpDir, 'test.db'));
      testSortedMap(core, new Hasher('SHA-1'));
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

function testSortedMap(core: Core, hasher: Hasher): void {
  core.setLength(0);
  const db = new Database(core, hasher);
  const decoder = new TextDecoder();

  // keys "k0000".."k0059" sort lexicographically in numeric order
  const COUNT = 60;
  const k = (i: number) => 'k' + String(i).padStart(4, '0');

  {
    const history = new WriteArrayList(db.rootCursor());
    history.appendContext(history.getSlot(-1), (cursor) => {
      const moment = new WriteHashMap(cursor);
      const map = new WriteSortedMap(moment.putCursor('map'));

      // insert in reverse order to exercise front-insertions and splits
      for (let i = COUNT; i > 0;) {
        i -= 1;
        map.put(k(i), new Uint(i));
      }
      assert.strictEqual(map.count(), COUNT);

      // dedup: re-putting an existing key replaces the value, not the count
      map.put('k0005', new Uint(999));
      assert.strictEqual(map.count(), COUNT);
      assert.strictEqual(map.getCursor('k0005')!.readUint(), 999);
      map.put('k0005', new Uint(5));

      // ordered iteration yields k0000..k0059 in order with intact values
      {
        let n = 0;
        const iter = map.iterator();
        while (iter.hasNext()) {
          const kv = iter.next()!.readKeyValuePair();
          assert.strictEqual(decoder.decode(kv.keyCursor.readBytes(MAX_READ_BYTES)), k(n));
          assert.strictEqual(kv.valueCursor.readUint(), n);
          n += 1;
        }
        assert.strictEqual(n, COUNT);
      }

      assert.notStrictEqual(map.getCursor('k0042'), null);
      assert.strictEqual(map.getCursor('nope'), null);

      // getByIndex (positive and negative) and rank are inverses
      {
        for (let idx = 0; idx < COUNT; idx++) {
          const kv = map.getIndexKeyValuePair(idx)!;
          const key = decoder.decode(kv.keyCursor.readBytes(MAX_READ_BYTES));
          assert.strictEqual(key, k(idx));
          assert.strictEqual(map.rank(key), idx);
        }
        const last = map.getIndexKeyValuePair(-1)!;
        assert.strictEqual(decoder.decode(last.keyCursor.readBytes(MAX_READ_BYTES)), 'k0059');
        assert.strictEqual(map.getIndexKeyValuePair(COUNT), null);
      }

      // lower-bound iteration from a present and an absent key
      {
        const iter = map.iteratorFrom('k0030');
        assert.strictEqual(decoder.decode(iter.next()!.readKeyValuePair().keyCursor.readBytes(MAX_READ_BYTES)), 'k0030');
      }
      {
        // "k00095" sorts between "k0009" and "k0010"
        const iter = map.iteratorFrom('k00095');
        assert.strictEqual(decoder.decode(iter.next()!.readKeyValuePair().keyCursor.readBytes(MAX_READ_BYTES)), 'k0010');
      }
      {
        const iter = map.iteratorFromIndex(COUNT - 2);
        assert.strictEqual(decoder.decode(iter.next()!.readKeyValuePair().keyCursor.readBytes(MAX_READ_BYTES)), 'k0058');
      }

      // remove the even keys, then re-verify order, count, and presence
      {
        for (let j = 0; j < COUNT; j += 2) {
          assert.ok(map.remove(k(j)));
        }
        assert.strictEqual(map.count(), COUNT / 2);
        assert.ok(!map.remove('k0000')); // already gone

        let expectI = 1;
        let seen = 0;
        const iter = map.iterator();
        while (iter.hasNext()) {
          const kv = iter.next()!.readKeyValuePair();
          assert.strictEqual(decoder.decode(kv.keyCursor.readBytes(MAX_READ_BYTES)), k(expectI));
          expectI += 2;
          seen += 1;
        }
        assert.strictEqual(seen, COUNT / 2);
      }

      // iterating-from on an unwritten (none) map yields nothing, like iterator()
      {
        const noneCursor = new ReadCursor(new SlotPointer(null, new Slot()), db);
        const empty = new ReadSortedMap(noneCursor);
        assert.ok(!empty.iteratorFrom('anything').hasNext());
        assert.ok(!empty.iteratorFromIndex(0).hasNext());
      }

      // SortedSet with mixed short (inline) and long (external) keys
      const set = new WriteSortedSet(moment.putCursor('set'));
      set.put('short');
      set.put('a-much-longer-key-stored-externally');
      set.put('mid');
      set.put('short'); // dup is a no-op
      assert.strictEqual(set.count(), 3);
      assert.ok(set.contains('mid'));
      assert.ok(!set.contains('nope'));
      {
        const want = ['a-much-longer-key-stored-externally', 'mid', 'short'];
        let n = 0;
        const iter = set.iterator();
        while (iter.hasNext()) {
          const kv = iter.next()!.readKeyValuePair();
          assert.strictEqual(decoder.decode(kv.keyCursor.readBytes(MAX_READ_BYTES)), want[n]);
          n += 1;
        }
        assert.strictEqual(n, 3);
      }
      assert.ok(set.remove('mid'));
      assert.strictEqual(set.count(), 2);

      // immutability guards: positional access is read-only, and keys/entries cannot be
      // overwritten through the low-level path API
      assert.throws(() => {
        (map.cursor as WriteCursor).writePath([new SortedMapGetIndex(0)]);
      }, WriteNotAllowedException);
      assert.throws(() => {
        (map.cursor as WriteCursor).writePath([
          new SortedMapGet(new SortedMapGetKey(new TextEncoder().encode('k0001'))),
          new WriteData(new Bytes('x')),
        ]);
      }, CursorNotWriteableException);
    });
  }

  // the map persists in the committed moment
  {
    const history = new ReadArrayList(db.rootCursor());
    const moment = new ReadHashMap(history.getCursor(-1)!);
    const map = new ReadSortedMap(moment.getCursor('map')!);
    assert.strictEqual(map.count(), COUNT / 2);
    assert.strictEqual(decoder.decode(map.getIndexKeyValuePair(0)!.keyCursor.readBytes(MAX_READ_BYTES)), 'k0001');
  }

  // a second moment that inherits and mutates the map must not disturb the first
  // (copy-on-write immutability across transactions)
  {
    const history = new WriteArrayList(db.rootCursor());
    history.appendContext(history.getSlot(-1), (cursor) => {
      const moment = new WriteHashMap(cursor);
      const map = new WriteSortedMap(moment.putCursor('map'));
      assert.ok(map.remove('k0001'));
      map.put('k0001', new Uint(7)); // not in moment 0
    });
  }
  {
    const history = new ReadArrayList(db.rootCursor());

    // moment 0 (original) is unchanged: k0001 still present with value 1
    const m0 = new ReadHashMap(history.getCursor(0)!);
    const map0 = new ReadSortedMap(m0.getCursor('map')!);
    assert.strictEqual(map0.count(), COUNT / 2);
    assert.strictEqual(map0.getCursor('k0001')!.readUint(), 1);

    // moment 1 reflects the mutation: k0001 re-added with value 7
    const m1 = new ReadHashMap(history.getCursor(1)!);
    const map1 = new ReadSortedMap(m1.getCursor('map')!);
    assert.strictEqual(map1.count(), COUNT / 2);
    assert.strictEqual(map1.getCursor('k0001')!.readUint(), 7);
  }
}

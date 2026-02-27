<p align="center">
  xitdb is an immutable database written in TypeScript
  <br/>
  <br/>
  <b>Choose your flavor:</b>
  <a href="https://github.com/xit-vcs/xitdb">Zig</a> |
  <a href="https://github.com/xit-vcs/xitdb-java">Java</a> |
  <a href="https://github.com/codeboost/xitdb-clj">Clojure</a> |
  <a href="https://github.com/xit-vcs/xitdb-ts">TypeScript</a>
</p>

* Each transaction efficiently creates a new "copy" of the database, and past copies can still be read from and reverted to.
* Supports storing in a single file as well as purely in-memory use.
* Runs as a library (embedded in process).
* Incrementally reads and writes, so file-based databases can contain larger-than-memory datasets.
* Reads never block writes, and a database can be read from multiple threads/processes without locks.
* No query engine of any kind. You just write data structures (primarily an `ArrayList` and `HashMap`) that can be nested arbitrarily.
* No dependencies besides the JavaScript standard library.
* Available [on npm](https://www.npmjs.com/package/xitdb).

This database was originally made for the [xit version control system](https://github.com/xit-vcs/xit), but I bet it has a lot of potential for other projects. The combination of being immutable and having an API similar to in-memory data structures is pretty powerful. Consider using it [instead of SQLite](https://gist.github.com/radarroark/03a0724484e1111ef4c05d72a935c42c) for your TypeScript projects: it's simpler, it's pure TypeScript, and it creates no impedance mismatch with your program the way SQL databases do.

* [Example](#example)
* [Initializing a Database](#initializing-a-database)
* [Types](#types)
* [Cloning and Undoing](#cloning-and-undoing)
* [Large Byte Arrays](#large-byte-arrays)
* [Iterators](#iterators)
* [Hashing](#hashing)
* [Compaction](#compaction)

## Example

In this example, we create a new database, write some data in a transaction, and read the data afterwards.

```typescript
// init the db
using core = await CoreBufferedFile.create('main.db');
const hasher = new Hasher('SHA-1');
const db = await Database.create(core, hasher);

// to get the benefits of immutability, the top-level data structure
// must be an ArrayList, so each transaction is stored as an item in it
const history = await WriteArrayList.create(db.rootCursor());

// this is how a transaction is executed. we call history.appendContext,
// providing it with the most recent copy of the db and a context
// function. the context function will run before the transaction has
// completed. this function is where we can write changes to the db.
// if any error happens in it, the transaction will not complete and
// the db will be unaffected.
//
// after this transaction, the db will look like this if represented
// as JSON (in reality the format is binary):
//
// {"foo": "foo",
//  "bar": "bar",
//  "fruits": ["apple", "pear", "grape"],
//  "people": [
//    {"name": "Alice", "age": 25},
//    {"name": "Bob", "age": 42}
//  ]}
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
});

// get the most recent copy of the database, like a moment
// in time. the -1 index will return the last index in the list.
const momentCursor = await history.getCursor(-1);
const moment = new ReadHashMap(momentCursor!);

// we can read the value of "foo" from the map by getting
// the cursor to "foo" and then calling readBytes on it
const fooCursor = await moment.getCursor('foo');
const fooValue = await fooCursor!.readBytes(MAX_READ_BYTES);
expect(new TextDecoder().decode(fooValue)).toBe('foo');

// to get the "fruits" list, we get the cursor to it and
// then pass it to the ReadArrayList constructor
const fruitsCursor = await moment.getCursor('fruits');
const fruits = new ReadArrayList(fruitsCursor!);
expect(await fruits.count()).toBe(3);

// now we can get the first item from the fruits list and read it
const appleCursor = await fruits.getCursor(0);
const appleValue = await appleCursor!.readBytes(MAX_READ_BYTES);
expect(new TextDecoder().decode(appleValue)).toBe('apple');
```

## Initializing a Database

A `Database` is initialized with an implementation of the `Core` interface, which determines how the i/o is done. There are three implementations of `Core` in this library: `CoreBufferedFile`, `CoreFile`, and `CoreMemory`.

* `CoreBufferedFile` databases, like in the example above, write to a file while using an in-memory buffer to dramatically improve performance. This is highly recommended if you want to create a file-based database.
* `CoreFile` databases use no buffering when reading and writing data. This is almost never necessary but it's useful as a benchmark comparison with `CoreBufferedFile` databases.
* `CoreMemory` databases work completely in memory.

Usually, you want to use a top-level `ArrayList` like in the example above, because that allows you to store a reference to each copy of the database (which I call a "moment"). This is how it supports transactions, despite not having any rollback journal or write-ahead log. It's an append-only database, so the data you are writing is invisible to any reader until the very last step, when the top-level list's header is updated.

You can also use a top-level `HashMap`, which is useful for ephemeral databases where immutability or transaction safety isn't necessary. Since xitdb supports in-memory databases, you could use it as an over-the-wire serialization format. Much like "Cap'n Proto", xitdb has no encoding/decoding step: you just give the buffer to xitdb and it can immediately read from it.

## Types

In xitdb there are a variety of immutable data structures that you can nest arbitrarily:

* `HashMap` contains key-value pairs stored with a hash
* `HashSet` is like a `HashMap` that only sets the keys; it is useful when only checking for membership
* `CountedHashMap` and `CountedHashSet` are just a `HashMap` and `HashSet` that maintain a count of their contents
* `ArrayList` is a growable array
* `LinkedArrayList` is like an `ArrayList` that can also be efficiently sliced and concatenated

All data structures use the hash array mapped trie, invented by Phil Bagwell. The `LinkedArrayList` is based on his later work on RRB trees. These data structures were originally made immutable and widely available by Rich Hickey in Clojure. To my knowledge, they haven't been available in any open source database until xitdb.

There are also scalar types you can store in the above-mentioned data structures:

* `Bytes` is a byte array
* `Uint` is an unsigned 64-bit int
* `Int` is a signed 64-bit int
* `Float` is a 64-bit float

You may also want to define custom types. For example, you may want to store a big integer that can't fit in 64 bits. You could just store this with `Bytes`, but when reading the byte array there wouldn't be any indication that it should be interpreted as a big integer.

In xitdb, you can optionally store a format tag with a byte array. A format tag is a 2 byte tag that is stored alongside the byte array. Readers can use it to decide how to interpret the byte array. Here's an example of storing a random 256-bit number with `bi` as the format tag:

```typescript
const randomBytes = new Uint8Array(32);
crypto.getRandomValues(randomBytes);
await moment.put('random-number', new Bytes(randomBytes, new TextEncoder().encode('bi')));
```

Then, you can read it like this:

```typescript
const randomNumberCursor = await moment.getCursor('random-number');
const randomNumber = await randomNumberCursor!.readBytesObject(MAX_READ_BYTES);
expect(new TextDecoder().decode(randomNumber.formatTag!)).toBe('bi');
const randomBigInt = randomNumber.value;
```

There are many types you may want to store this way. Maybe an ISO-8601 date like `2026-01-01T18:55:48Z` could be stored with `dt` as the format tag. It's also great for storing custom objects. Just define the object, serialize it as a byte array using whatever mechanism you wish, and store it with a format tag. Keep in mind that format tags can be *any* 2 bytes, so there are 65536 possible format tags.

## Cloning and Undoing

A powerful feature of immutable data is fast cloning. Any data structure can be instantly cloned and changed without affecting the original. Starting with the example code above, we can make a new transaction that creates a "food" list based on the existing "fruits" list:

```typescript
await history.appendContext(await history.getSlot(-1), async (cursor) => {
  const moment = await WriteHashMap.create(cursor);

  const fruitsCursor = await moment.getCursor('fruits');
  const fruits = new ReadArrayList(fruitsCursor!);

  // create a new key called "food" whose initial value is
  // based on the "fruits" list
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
```

Before we continue, let's save the latest history index, so we can revert back to this moment of the database later:

```typescript
const historyIndex = (await history.count()) - 1;
```

There's one catch you'll run into when cloning. If we try cloning a data structure that was created in the same transaction, it doesn't seem to work:

```typescript
await history.appendContext(await history.getSlot(-1), async (cursor) => {
  const moment = await WriteHashMap.create(cursor);

  const bigCitiesCursor = await moment.putCursor('big-cities');
  const bigCities = await WriteArrayList.create(bigCitiesCursor);
  await bigCities.append(new Bytes('New York, NY'));
  await bigCities.append(new Bytes('Los Angeles, CA'));

  // create a new key called "cities" whose initial value is
  // based on the "big-cities" list
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
```

The reason that `big-cities` was mutated is because all data in a given transaction is temporarily mutable. This is a very important optimization, but in this case, it's not what we want.

To show how to fix this, let's first undo the transaction we just made. Here we use the `historyIndex` we saved before to revert back to the older database moment:

```typescript
await history.append((await history.getSlot(historyIndex))!);
```

This time, after making the "big cities" list, we call `freeze`, which tells xitdb to consider all data made so far in the transaction to be immutable. After that, we can clone it into the "cities" list and it will work the way we wanted:

```typescript
await history.appendContext(await history.getSlot(-1), async (cursor) => {
  const moment = await WriteHashMap.create(cursor);

  const bigCitiesCursor = await moment.putCursor('big-cities');
  const bigCities = await WriteArrayList.create(bigCitiesCursor);
  await bigCities.append(new Bytes('New York, NY'));
  await bigCities.append(new Bytes('Los Angeles, CA'));

  // freeze here, so big-cities won't be mutated
  cursor.db.freeze();

  // create a new key called "cities" whose initial value is
  // based on the "big-cities" list
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
```

## Large Byte Arrays

When reading and writing large byte arrays, you probably don't want to have all of their contents in memory at once. To incrementally write to a byte array, just get a writer from a cursor:

```typescript
const longTextCursor = await moment.putCursor('long-text');
const cursorWriter = await longTextCursor.writer();
for (let i = 0; i < 50; i++) {
  await cursorWriter.write(new TextEncoder().encode('hello, world\n'));
}
await cursorWriter.finish(); // remember to call this!
```

If you need to set a format tag for the byte array, put it in the `formatTag` field of the writer before you call `finish`.

To read a byte array incrementally, get a reader from a cursor:

```typescript
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
```

## Iterators

All data structures support iteration. Here's an example of iterating over an `ArrayList` and printing all of the keys and values of each `HashMap` contained in it:

```typescript
const peopleCursor = await moment.getCursor('people');
const people = new ReadArrayList(peopleCursor!);

const peopleIter = await people.iterator();
while (await peopleIter.hasNext()) {
  const personCursor = await peopleIter.next();
  const person = new ReadHashMap(personCursor!);
  const personIter = await person.iterator();
  while (await personIter.hasNext()) {
    const kvPairCursor = await personIter.next();
    const kvPair = await kvPairCursor!.readKeyValuePair();

    const key = new TextDecoder().decode(await kvPair.keyCursor.readBytes(MAX_READ_BYTES));

    switch (kvPair.valueCursor.slot().tag) {
      case Tag.SHORT_BYTES:
      case Tag.BYTES:
        console.log(`${key}: ${new TextDecoder().decode(await kvPair.valueCursor.readBytes(MAX_READ_BYTES))}`);
        break;
      case Tag.UINT:
        console.log(`${key}: ${kvPair.valueCursor.readUint()}`);
        break;
      case Tag.INT:
        console.log(`${key}: ${kvPair.valueCursor.readInt()}`);
        break;
      case Tag.FLOAT:
        console.log(`${key}: ${kvPair.valueCursor.readFloat()}`);
        break;
    }
  }
}
```

The above code iterates over `people`, which is an `ArrayList`, and for each person (which is a `HashMap`), it iterates over each of its key-value pairs.

The iteration of the `HashMap` looks the same with `HashSet`, `CountedHashMap`, and `CountedHashSet`. When iterating, you call `readKeyValuePair` on the cursor and can read the `keyCursor` and `valueCursor` from it. In maps, `put` sets the key and value. In sets, `put` only sets the key; the value will always have a tag type of `NONE`.

## Hashing

The hashing data structures will create the hash for you when you call methods like `put` or `getCursor` and provide the key as a string or `Bytes`. If you want to do the hashing yourself, there is an overload of those methods that take a `Uint8Array` as the key, which should be the hash that you computed.

When initializing a database, you tell xitdb how to hash with the `Hasher`. If you're using SHA-1, it will look like this:

```typescript
using core = await CoreBufferedFile.create('main.db');
const hasher = new Hasher('SHA-1');
const db = await Database.create(core, hasher);
```

The size of the hash in bytes will be stored in the database's header. If you try opening it later with a hashing algorithm that has the wrong hash size, it will throw an exception. If you are unsure what hash size the database uses, this creates a chicken-and-egg problem. You can read the header before initializing the database like this:

```typescript
await core.seek(0);
const header = await Header.read(core);
expect(header.hashSize).toBe(20);
```

The hash size alone does not disambiguate hashing algorithms, though. In addition, xitdb reserves four bytes in the header that you can use to put the name of the algorithm. You must provide it in the `Hasher` constructor:

```typescript
const hasher = new Hasher('SHA-1', Hasher.stringToId('sha1'));
```

The hash id is only written to the database header when it is first initialized. When you open it later, the hash id in the `Hasher` is ignored. You can read the hash id of an existing database like this:

```typescript
await core.seek(0);
const header = await Header.read(core);
expect(Hasher.idToString(header.hashId)).toBe("sha1");
```

If you want to use SHA-256, I recommend using `sha2` as the hash id. You can then distinguish between SHA-256 and SHA-512 using the hash size, like this:

```typescript
let hasher: Hasher;
const hashIdStr = Hasher.idToString(header.hashId);

switch (hashIdStr) {
  case 'sha1':
    hasher = new Hasher('SHA-1', header.hashId);
    break;
  case 'sha2':
    switch (header.hashSize) {
      case 32:
        hasher = new Hasher('SHA-256', header.hashId);
        break;
      case 64:
        hasher = new Hasher('SHA-512', header.hashId);
        break;
      default:
        throw new Error('Invalid hash size');
    }
    break;
  default:
    throw new Error('Invalid hash algorithm');
}
```

## Compaction

Normally, an immutable database grows forever, because old data is never deleted. To reclaim disk space and clear the history, xitdb supports compaction. This involves completely rebuilding the database file to only contain the data accessible from the latest copy (i.e., "moment") of the database.

```typescript
using compactCore = await CoreBufferedFile.create('compact.db');
const compactDb = await db.compact(compactCore);

// read from the new compacted db
const history = new ReadArrayList(compactDb.rootCursor());
expect(await history.count()).toBe(1);
```

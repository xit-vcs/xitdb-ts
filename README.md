<p align="center">
  xitdb is an immutable database written in TypeScript
  <br/>
  <br/>
  <b>Choose your flavor:</b>
  <a href="https://github.com/xit-vcs/xitdb">Zig</a> |
  <a href="https://github.com/xit-vcs/xitdb-java">Java</a> |
  <a href="https://github.com/codeboost/xitdb-clj">Clojure</a> |
  <a href="https://github.com/xit-vcs/xitdb-ts">TypeScript</a> |
  <a href="https://github.com/xit-vcs/xitdb-go">Go</a>
</p>

* Each transaction efficiently creates a new "copy" of the database, and past copies can still be read from and reverted to.
* Supports storing in a single file as well as purely in-memory use.
* Runs as a library (embedded in process).
* Incrementally reads and writes, so file-based databases can contain larger-than-memory datasets.
* Reads never block writes, and a database can be read from multiple threads/processes without locks.
* No query engine of any kind. You just write data structures (primarily an `ArrayList` and `HashMap`) that can be nested arbitrarily.
* No dependencies besides the JavaScript standard library.
* Fully synchronous API — no async/await needed.
* Available [on npm](https://www.npmjs.com/package/xitdb).

This database was originally made for the [xit version control system](https://github.com/xit-vcs/xit), but I bet it has a lot of potential for other projects. The combination of being immutable and having an API similar to in-memory data structures is pretty powerful. Consider using it [instead of SQLite](https://gist.github.com/xeubie/03a0724484e1111ef4c05d72a935c42c) for your TypeScript projects: it's simpler, it's pure TypeScript, and it creates no impedance mismatch with your program the way SQL databases do.

* [Example](#example)
* [Initializing a Database](#initializing-a-database)
* [Types](#types)
* [Cloning and Undoing](#cloning-and-undoing)
* [Sorting and Paginating](#sorting-and-paginating)
* [Large Byte Arrays](#large-byte-arrays)
* [Iterators](#iterators)
* [Hashing](#hashing)
* [Compaction](#compaction)

## Example

In this example, we create a new database, write some data in a transaction, and read the data afterwards.

```typescript
// init the db
using core = new CoreBufferedFile('main.db');
const hasher = new Hasher('SHA-1');
const db = new Database(core, hasher);

// to get the benefits of immutability, the top-level data structure
// must be an ArrayList, so each transaction is stored as an item in it
const history = new WriteArrayList(db.rootCursor());

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
});

// get the most recent copy of the database, like a moment
// in time. the -1 index will return the last index in the list.
const momentCursor = history.getCursor(-1);
const moment = new ReadHashMap(momentCursor!);

// we can read the value of "foo" from the map by getting
// the cursor to "foo" and then calling readBytes on it
const fooCursor = moment.getCursor('foo');
const fooValue = fooCursor!.readBytes(MAX_READ_BYTES);
assert.strictEqual(new TextDecoder().decode(fooValue), 'foo');

// to get the "fruits" list, we get the cursor to it and
// then pass it to the ReadArrayList constructor
const fruitsCursor = moment.getCursor('fruits');
const fruits = new ReadArrayList(fruitsCursor!);
assert.strictEqual(fruits.count(), 3);

// now we can get the first item from the fruits list and read it
const appleCursor = fruits.getCursor(0);
const appleValue = appleCursor!.readBytes(MAX_READ_BYTES);
assert.strictEqual(new TextDecoder().decode(appleValue), 'apple');
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
* `SortedMap` and `SortedSet` are like a `HashMap` and `HashSet` where the keys are byte arrays kept in lexicographic order

The `Hash`-based data structures and the `Arraylist` use the hash array mapped trie, invented by Phil Bagwell (originally made immutable and widely available by Rich Hickey in Clojure). The `LinkedArrayList`, `SortedMap`, and `SortedSet` are based on a B-tree.

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
moment.put('random-number', new Bytes(randomBytes, new TextEncoder().encode('bi')));
```

Then, you can read it like this:

```typescript
const randomNumberCursor = moment.getCursor('random-number');
const randomNumber = randomNumberCursor!.readBytesObject(MAX_READ_BYTES);
assert.strictEqual(new TextDecoder().decode(randomNumber.formatTag!), 'bi');
const randomBigInt = randomNumber.value;
```

There are many types you may want to store this way. Maybe an ISO-8601 date like `2026-01-01T18:55:48Z` could be stored with `dt` as the format tag. It's also great for storing custom objects. Just define the object, serialize it as a byte array using whatever mechanism you wish, and store it with a format tag. Keep in mind that format tags can be *any* 2 bytes, so there are 65536 possible format tags.

## Cloning and Undoing

A powerful feature of immutable data is fast cloning. Any data structure can be instantly cloned and changed without affecting the original. Starting with the example code above, we can make a new transaction that creates a "food" list based on the existing "fruits" list:

```typescript
history.appendContext(history.getSlot(-1), (cursor) => {
  const moment = new WriteHashMap(cursor);

  const fruitsCursor = moment.getCursor('fruits');
  const fruits = new ReadArrayList(fruitsCursor!);

  // create a new key called "food" whose initial value is
  // based on the "fruits" list
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
```

Before we continue, let's save the latest history index, so we can revert back to this moment of the database later:

```typescript
const historyIndex = history.count() - 1;
```

There's one catch you'll run into when cloning. If we try cloning a data structure that was created in the same transaction, it doesn't seem to work:

```typescript
history.appendContext(history.getSlot(-1), (cursor) => {
  const moment = new WriteHashMap(cursor);

  const bigCitiesCursor = moment.putCursor('big-cities');
  const bigCities = new WriteArrayList(bigCitiesCursor);
  bigCities.append(new Bytes('New York, NY'));
  bigCities.append(new Bytes('Los Angeles, CA'));

  // create a new key called "cities" whose initial value is
  // based on the "big-cities" list
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
```

The reason that `big-cities` was mutated is because all data in a given transaction is temporarily mutable. This is a very important optimization, but in this case, it's not what we want.

To show how to fix this, let's first undo the transaction we just made. Here we use the `historyIndex` we saved before to revert back to the older database moment:

```typescript
history.append(history.getSlot(historyIndex)!);
```

This time, after making the "big cities" list, we call `freeze`, which tells xitdb to consider all data made so far in the transaction to be immutable. After that, we can clone it into the "cities" list and it will work the way we wanted:

```typescript
history.appendContext(history.getSlot(-1), (cursor) => {
  const moment = new WriteHashMap(cursor);

  const bigCitiesCursor = moment.putCursor('big-cities');
  const bigCities = new WriteArrayList(bigCitiesCursor);
  bigCities.append(new Bytes('New York, NY'));
  bigCities.append(new Bytes('Los Angeles, CA'));

  // freeze here, so big-cities won't be mutated
  cursor.db.freeze();

  // create a new key called "cities" whose initial value is
  // based on the "big-cities" list
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
```

## Sorting and Paginating

The `Hash`-based structures are great for looking data up by key, but they store their contents in hash order, which is meaningless to a human. Real apps need to show data in a sensible order (such as users listed alphabetically) one page at a time. Relational databases like SQLite have this built-in: you declare a `CREATE INDEX`, write `ORDER BY username LIMIT 20 OFFSET 40`, and the query planner maintains the index for you.

In xitdb there are no built-in indexes, so you build and maintain them yourself. That's a little more code, but the index is just another data structure: a `SortedMap` whose keys sort the way you want. You keep it in sync by writing to it in the same transaction that writes the primary data.

Why a `SortedMap` and not an `ArrayList`? An `ArrayList` keeps things in insertion order, which is only useful when the order you want *is* the order you wrote them in. The moment you want a different order (alphabetical, by score, by anything that isn't "when it arrived") you need a structure that stays sorted by a key. A `SortedMap` does, and it can seek straight to the first key greater than or equal to a given value, which is what makes type-ahead search possible.

Let's model a user directory: a collection of users we look up by id, plus a secondary index that lists them alphabetically by username. The primary store is a `HashMap` from user id to the user's fields (like a row keyed by its primary key). The secondary index is a `SortedMap` keyed by username, whose value is the user id to look up.

A `SortedMap` orders its keys lexicographically by their raw bytes. For ASCII usernames that's just alphabetical order, and since usernames are unique, every key is already distinct, so the key is simply the username itself. For a sort key that *isn't* unique, like a score, you'd append the id to keep keys distinct. See the note at the end.

Now we write some users. Note they're inserted in arbitrary order; the index sorts them, so insertion order doesn't matter. On each insert we write the user into the primary map and add an entry to the secondary index (keeping both in sync is your job, not the database's):

```typescript
interface User {
  id: string;
  username: string;
  name: string;
}

// inserted in arbitrary order; the index will sort them alphabetically
const newUsers: User[] = [
  { id: 'user000000000001', username: 'dave', name: 'Dave Smith' },
  { id: 'user000000000002', username: 'alice', name: 'Alice Jones' },
  { id: 'user000000000003', username: 'carol', name: 'Carol White' },
  { id: 'user000000000004', username: 'dan', name: 'Dan Brown' },
  { id: 'user000000000005', username: 'bob', name: 'Bob Lee' },
  { id: 'user000000000006', username: 'eve', name: 'Eve Adams' },
];

history.appendContext(history.getSlot(-1), (cursor) => {
  const moment = new WriteHashMap(cursor);

  // the primary store: a HashMap from user id to the user's fields
  const idToUserCursor = moment.putCursor('id->user');
  const idToUser = new WriteHashMap(idToUserCursor);

  // the secondary index: a SortedMap ordered alphabetically by username.
  // there's no CREATE INDEX here, so we maintain it ourselves on every write.
  const usernameToIdCursor = moment.putCursor('username->id');
  const usernameToId = new WriteSortedMap(usernameToIdCursor);

  for (const user of newUsers) {
    // write the user into the primary map under its id
    const userCursor = idToUser.putCursor(user.id);
    const userMap = new WriteHashMap(userCursor);
    userMap.put('username', new Bytes(user.username));
    userMap.put('name', new Bytes(user.name));

    // add an entry to the secondary index: the key is the username (the
    // sort key), and the value is the user id we'll use to look it back up.
    usernameToId.put(user.username, new Bytes(user.id));
  }
});
```

To display a page, we walk the `SortedMap` instead of the `HashMap`. A web app would take a `pageSize` and an `after` offset from the request (something like `/users?after=20`), so this is the xitdb equivalent of `ORDER BY username LIMIT pageSize OFFSET after`:

```typescript
const momentCursor = history.getCursor(-1);
const moment = new ReadHashMap(momentCursor!);

const idToUserCursor = moment.getCursor('id->user');
const idToUser = new ReadHashMap(idToUserCursor!);

const usernameToIdCursor = moment.getCursor('username->id');
const usernameToId = new ReadSortedMap(usernameToIdCursor!);

// a web request would supply these; here we just grab the first page
const pageSize = 2;
const after = 0;

const count = usernameToId.count();
const end = Math.min(after + pageSize, count);

// seek straight to the start of the page, then walk forward one entry at a
// time. because SortedMap is a count-augmented B+tree, iteratorFromIndex
// finds rank `after` in O(log n) without scanning the entries it skips, so
// jumping to page 500 is just as cheap as page 1.
const decoder = new TextDecoder();
const iter = usernameToId.iteratorFromIndex(after);
for (let i = after; i < end && iter.hasNext(); i++) {
  const idCursor = iter.next()!;
  const idKv = idCursor.readKeyValuePair();

  // the index entry's value is the user id; use it to read the
  // full user out of the primary map
  const userId = decoder.decode(idKv.valueCursor.readBytes(MAX_READ_BYTES));

  const userCursor = idToUser.getCursor(userId);
  const userMap = new ReadHashMap(userCursor!);
  const nameCursor = userMap.getCursor('name');
  const name = decoder.decode(nameCursor!.readBytes(MAX_READ_BYTES));

  // a real app would render this into the page's HTML
  console.log(name);
}
```

Pagination by index is only half of what the ordering buys us. Because the index is sorted by username, we can also seek straight to a *key* (the first username greater than or equal to a prefix) and walk forward only as far as the prefix matches. That's a type-ahead search (think @-mention autocomplete), and it's the thing an `ArrayList` can't do: with no sorted index, there's nothing to seek into. We use `iteratorFrom` (which takes a key) instead of `iteratorFromIndex` (which takes a rank):

```typescript
// the user typed "da" into an @-mention box; find everyone whose username
// starts with it. iteratorFrom seeks to the first key >= "da" in O(log n),
// then we walk forward until a username no longer starts with the prefix.
const prefix = 'da';
const acIter = usernameToId.iteratorFrom(prefix);
while (acIter.hasNext()) {
  const idCursor = acIter.next()!;
  const idKv = idCursor.readKeyValuePair();

  // the key is the username; stop once we've walked past the prefix
  const username = decoder.decode(idKv.keyCursor.readBytes(MAX_READ_BYTES));
  if (!username.startsWith(prefix)) break;

  // a real app would offer this as a suggestion (here: "dan", then "dave")
  console.log(username);
}
```

This works for any ordering you need: sort by a username with a string key like we did here, by score with a big-endian integer key (encode numbers big-endian so their byte order matches numeric order), or build several `SortedMap` indexes over the same primary `HashMap` to offer the data in different orders. When a sort key isn't unique (many users could share a score), append the id to keep every key distinct:

```typescript
const userIdSize = 16;

// build a SortedMap key that sorts by score. the big-endian score makes byte
// order match numeric order; the user id is appended so two users with the
// same score still get distinct keys.
function orderKey(score: number, userId: Uint8Array): Uint8Array {
  const key = new Uint8Array(8 + userIdSize);
  new DataView(key.buffer).setBigUint64(0, BigInt(score), false); // false = big-endian
  key.set(userId, 8);
  return key;
}
```

With xitdb you "bring your own index". It takes a bit more effort than the declarative convenience of SQL databases, but it gives you more explicit control, and avoids the common problem in SQL where queries silently become inefficient due to not using indexes. In xitdb, inefficiency is hard to miss because you are always writing your queries as imperative code and the indexes are always explicit.

## Large Byte Arrays

When reading and writing large byte arrays, you probably don't want to have all of their contents in memory at once. To incrementally write to a byte array, just get a writer from a cursor:

```typescript
const longTextCursor = moment.putCursor('long-text');
const cursorWriter = longTextCursor.writer();
for (let i = 0; i < 50; i++) {
  cursorWriter.write(new TextEncoder().encode('hello, world\n'));
}
cursorWriter.finish(); // remember to call this!
```

If you need to set a format tag for the byte array, put it in the `formatTag` field of the writer before you call `finish`.

To read a byte array incrementally, get a reader from a cursor:

```typescript
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
```

## Iterators

All data structures support iteration. Here's an example of iterating over an `ArrayList` and printing all of the keys and values of each `HashMap` contained in it:

```typescript
const peopleCursor = moment.getCursor('people');
const people = new ReadArrayList(peopleCursor!);

const peopleIter = people.iterator();
while (peopleIter.hasNext()) {
  const personCursor = peopleIter.next();
  const person = new ReadHashMap(personCursor!);
  const personIter = person.iterator();
  while (personIter.hasNext()) {
    const kvPairCursor = personIter.next();
    const kvPair = kvPairCursor!.readKeyValuePair();

    const key = new TextDecoder().decode(kvPair.keyCursor.readBytes(MAX_READ_BYTES));

    switch (kvPair.valueCursor.slot().tag) {
      case Tag.SHORT_BYTES:
      case Tag.BYTES:
        console.log(`${key}: ${new TextDecoder().decode(kvPair.valueCursor.readBytes(MAX_READ_BYTES))}`);
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

`ArrayList` and `LinkedArrayList` also have an `iteratorFrom` method, which starts the iterator from the given index. `SortedMap` and `SortedSet` have `iteratorFrom` and `iteratorFromIndex` to start the iterator from a key or index respectively. This is especially useful for pagination: you can seek straight to the start of a page and walk forward only as far as you need. See the [Sorting and Paginating](#sorting-and-paginating) section for an example.

## Hashing

The hashing data structures will create the hash for you when you call methods like `put` or `getCursor` and provide the key as a string or `Bytes`. If you want to do the hashing yourself, there is an overload of those methods that take a `Uint8Array` as the key, which should be the hash that you computed.

When initializing a database, you tell xitdb how to hash with the `Hasher`. If you're using SHA-1, it will look like this:

```typescript
using core = new CoreBufferedFile('main.db');
const hasher = new Hasher('SHA-1');
const db = new Database(core, hasher);
```

The size of the hash in bytes will be stored in the database's header. If you try opening it later with a hashing algorithm that has the wrong hash size, it will throw an exception. If you are unsure what hash size the database uses, this creates a chicken-and-egg problem. You can read the header before initializing the database like this:

```typescript
core.seek(0);
const header = Header.read(core);
assert.strictEqual(header.hashSize, 20);
```

The hash size alone does not disambiguate hashing algorithms, though. In addition, xitdb reserves four bytes in the header that you can use to put the name of the algorithm. You must provide it in the `Hasher` constructor:

```typescript
const hasher = new Hasher('SHA-1', Hasher.stringToId('sha1'));
```

The hash id is only written to the database header when it is first initialized. When you open it later, the hash id in the `Hasher` is ignored. You can read the hash id of an existing database like this:

```typescript
core.seek(0);
const header = Header.read(core);
assert.strictEqual(Hasher.idToString(header.hashId), "sha1");
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
using compactCore = new CoreBufferedFile('compact.db');
const compactDb = db.compact(compactCore);

// read from the new compacted db
const history = new ReadArrayList(compactDb.rootCursor());
assert.strictEqual(history.count(), 1);
```

This compacted database will be in a separate file. If you want to delete the original database and replace it with this one, you'll need to do that yourself. It is not possible to compact a database in-place (using the same file as the target database); doing so would fail and would render your original database unreadable.

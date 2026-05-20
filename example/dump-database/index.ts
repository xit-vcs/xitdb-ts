#!/usr/bin/env tsx
import {
  Database,
  Hasher,
  CoreBufferedFile,
  ReadArrayList,
  ReadCursor,
  Tag,
} from 'xitdb';

function formatKey(cursor: ReadCursor): string {
  const tag = cursor.slotPtr.slot.tag;

  switch (tag) {
    case Tag.NONE:
      return '(none)';
    case Tag.BYTES:
    case Tag.SHORT_BYTES: {
      const bytes = cursor.readBytes(null);
      const text = new TextDecoder().decode(bytes);
      return `"${text}"`;
    }
    case Tag.UINT:
      return `${cursor.readUint()}`;
    case Tag.INT:
      return `${cursor.readInt()}`;
    case Tag.FLOAT:
      return `${cursor.readFloat()}`;
    default:
      return `<key tag: ${tag}>`;
  }
}

function getKeyValue(cursor: ReadCursor): string | number {
  const tag = cursor.slotPtr.slot.tag;

  switch (tag) {
    case Tag.BYTES:
    case Tag.SHORT_BYTES: {
      const bytes = cursor.readBytes(null);
      return new TextDecoder().decode(bytes);
    }
    case Tag.UINT:
      return Number(cursor.readUint());
    case Tag.INT:
      return Number(cursor.readInt());
    case Tag.FLOAT:
      return cursor.readFloat();
    default:
      return `<key tag: ${tag}>`;
  }
}

function toJsonValue(cursor: ReadCursor, isRoot = false): unknown {
  const tag = cursor.slotPtr.slot.tag;

  switch (tag) {
    case Tag.NONE:
      return null;

    case Tag.ARRAY_LIST: {
      const list = new ReadArrayList(cursor);
      const count = list.count();
      if (isRoot) {
        const itemCursor = list.getCursor(count - 1);
        if (itemCursor) {
          return toJsonValue(itemCursor);
        }
        return null;
      }
      const result: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const itemCursor = list.getCursor(i);
        if (itemCursor) {
          result.push(toJsonValue(itemCursor));
        }
      }
      return result;
    }

    case Tag.HASH_MAP:
    case Tag.COUNTED_HASH_MAP: {
      const iter = cursor.iterator();
      const result: Record<string, unknown> = {};

      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        if (kvPairCursor) {
          const kvPair = kvPairCursor.readKeyValuePair();
          const key = getKeyValue(kvPair.keyCursor);
          result[String(key)] = toJsonValue(kvPair.valueCursor);
        }
      }
      return result;
    }

    case Tag.HASH_SET:
    case Tag.COUNTED_HASH_SET: {
      const iter = cursor.iterator();
      const result: (string | number)[] = [];

      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        if (kvPairCursor) {
          const kvPair = kvPairCursor.readKeyValuePair();
          const key = getKeyValue(kvPair.keyCursor);
          result.push(key);
        }
      }
      return result;
    }

    case Tag.LINKED_ARRAY_LIST: {
      const result: unknown[] = [];
      const iter = cursor.iterator();
      while (iter.hasNext()) {
        const itemCursor = iter.next();
        if (itemCursor) {
          result.push(toJsonValue(itemCursor));
        }
      }
      return result;
    }

    case Tag.BYTES:
    case Tag.SHORT_BYTES: {
      const bytesObj = cursor.readBytesObject(null);
      const text = new TextDecoder().decode(bytesObj.value);
      const isPrintable = /^[\x20-\x7E\n\r\t]*$/.test(text);

      if (isPrintable) {
        return text;
      } else {
        // Return base64 for binary data
        const binary = String.fromCharCode(...bytesObj.value);
        return { _binary: btoa(binary) };
      }
    }

    case Tag.UINT:
      return Number(cursor.readUint());

    case Tag.INT:
      return Number(cursor.readInt());

    case Tag.FLOAT:
      return cursor.readFloat();

    default:
      return { _unknown: tag };
  }
}

function printValue(cursor: ReadCursor, indent: string): void {
  const tag = cursor.slotPtr.slot.tag;

  switch (tag) {
    case Tag.NONE:
      console.log(`${indent}(none)`);
      break;

    case Tag.ARRAY_LIST: {
      const list = new ReadArrayList(cursor);
      const count = list.count();
      console.log(`${indent}ArrayList[${count}]:`);
      if (indent == '') {
        const itemCursor = list.getCursor(count - 1);
        if (itemCursor) {
          printValue(itemCursor, indent + '    ');
        }
      } else {
        for (let i = 0; i < count; i++) {
          const itemCursor = list.getCursor(i);
          if (itemCursor) {
            console.log(`${indent}  [${i}]:`);
            printValue(itemCursor, indent + '    ');
          }
        }
      }
      break;
    }

    case Tag.HASH_MAP:
    case Tag.COUNTED_HASH_MAP: {
      const iter = cursor.iterator();
      const entries: Array<{ key: string; valueCursor: ReadCursor }> = [];

      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        if (kvPairCursor) {
          const kvPair = kvPairCursor.readKeyValuePair();
          const key = formatKey(kvPair.keyCursor);
          entries.push({ key, valueCursor: kvPair.valueCursor });
        }
      }

      const prefix = tag === Tag.COUNTED_HASH_MAP ? 'CountedHashMap' : 'HashMap';
      console.log(`${indent}${prefix}{${entries.length}}:`);

      for (const entry of entries) {
        console.log(`${indent}  ${entry.key}:`);
        printValue(entry.valueCursor, indent + '    ');
      }
      break;
    }

    case Tag.HASH_SET:
    case Tag.COUNTED_HASH_SET: {
      const iter = cursor.iterator();
      const keys: string[] = [];

      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        if (kvPairCursor) {
          const kvPair = kvPairCursor.readKeyValuePair();
          const key = formatKey(kvPair.keyCursor);
          keys.push(key);
        }
      }

      const prefix = tag === Tag.COUNTED_HASH_SET ? 'CountedHashSet' : 'HashSet';
      console.log(`${indent}${prefix}{${keys.length}}: [${keys.join(', ')}]`);
      break;
    }

    case Tag.LINKED_ARRAY_LIST: {
      const count = cursor.count();
      console.log(`${indent}LinkedArrayList[${count}]:`);
      const iter = cursor.iterator();
      let i = 0;
      while (iter.hasNext()) {
        const itemCursor = iter.next();
        if (itemCursor) {
          console.log(`${indent}  [${i}]:`);
          printValue(itemCursor, indent + '    ');
        }
        i++;
      }
      break;
    }

    case Tag.BYTES:
    case Tag.SHORT_BYTES: {
      const bytesObj = cursor.readBytesObject(null);
      const text = new TextDecoder().decode(bytesObj.value);
      const isPrintable = /^[\x20-\x7E\n\r\t]*$/.test(text);

      if (isPrintable && text.length <= 100) {
        if (bytesObj.formatTag) {
          const formatTag = new TextDecoder().decode(bytesObj.formatTag);
          console.log(`${indent}"${text}" (format: ${formatTag})`);
        } else {
          console.log(`${indent}"${text}"`);
        }
      } else {
        const preview = bytesObj.value.slice(0, 16);
        const hex = Array.from(preview).map(b => b.toString(16).padStart(2, '0')).join(' ');
        if (bytesObj.formatTag) {
          const formatTag = new TextDecoder().decode(bytesObj.formatTag);
          console.log(`${indent}<${bytesObj.value.length} bytes: ${hex}...> (format: ${formatTag})`);
        } else {
          console.log(`${indent}<${bytesObj.value.length} bytes: ${hex}...>`);
        }
      }
      break;
    }

    case Tag.UINT: {
      const value = cursor.readUint();
      console.log(`${indent}${value} (uint)`);
      break;
    }

    case Tag.INT: {
      const value = cursor.readInt();
      console.log(`${indent}${value} (int)`);
      break;
    }

    case Tag.FLOAT: {
      const value = cursor.readFloat();
      console.log(`${indent}${value} (float)`);
      break;
    }

    default:
      console.log(`${indent}<unknown tag: ${tag}>`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');
  const fileArgs = args.filter(arg => arg !== '--json');

  if (fileArgs.length < 1) {
    console.error('Usage: tsx index.ts [--json] <database-file>');
    process.exit(1);
  }

  const filePath = fileArgs[0];

  try {
    const core = new CoreBufferedFile(filePath);
    const hasher = new Hasher('SHA-1');
    const db = new Database(core, hasher);

    const rootCursor = db.rootCursor();

    if (jsonFlag) {
      const json = toJsonValue(rootCursor, true);
      console.log(JSON.stringify(json, null, 2));
    } else {
      console.log(`Database: ${filePath}`);
      console.log('---');
      printValue(rootCursor, '');
    }

  } catch (error) {
    console.error(`Error reading database: ${error}`);
    process.exit(1);
  }
}

main();

import {
  Database,
  Hasher,
  CoreBufferedFile,
  ReadArrayList,
  ReadCursor,
  Tag,
} from 'xitdb';
import { toEDNString, toKeyword, toSymbol } from 'edn-data';
import type { EDNVal, EDNMap, EDNSet, EDNList, EDNKeyword, EDNSymbol } from 'edn-data/dist/types';

const FORMAT_TAG_KEYWORD = 'kw';
const FORMAT_TAG_SYMBOL = 'sy';
const FORMAT_TAG_BOOLEAN = 'bl';

export function exportEdn(dbPath: string): void {
  const core = new CoreBufferedFile(dbPath);
  const db = new Database(core, new Hasher('SHA-1'));
  const rootCursor = db.rootCursor();

  const history = new ReadArrayList(rootCursor);
  const count = history.count();

  if (count === 0) {
    console.log('{}');
    return;
  }

  const latest = history.getCursor(count - 1);
  if (!latest) {
    console.log('{}');
    return;
  }

  const ednValue = cursorToEdnValue(latest);
  const ednString = prettyPrintEdn(ednValue, 0);
  console.log(ednString);
}

function cursorToEdnValue(cursor: ReadCursor): EDNVal {
  const tag = cursor.slotPtr.slot.tag;

  switch (tag) {
    case Tag.NONE:
      return null;

    case Tag.BYTES:
    case Tag.SHORT_BYTES: {
      const bytesObj = cursor.readBytesObject(null);
      const text = new TextDecoder().decode(bytesObj.value);

      if (bytesObj.formatTag) {
        const formatTag = new TextDecoder().decode(bytesObj.formatTag);
        if (formatTag === FORMAT_TAG_BOOLEAN) {
          return text === 'true';
        }
        if (formatTag === FORMAT_TAG_KEYWORD) {
          return parseKeyword(text);
        }
        if (formatTag === FORMAT_TAG_SYMBOL) {
          return toSymbol(text);
        }
      }
      return text;
    }

    case Tag.UINT:
      return cursor.readUint();

    case Tag.INT:
      return cursor.readInt();

    case Tag.FLOAT:
      return cursor.readFloat();

    case Tag.ARRAY_LIST: {
      const list = new ReadArrayList(cursor);
      const count = list.count();
      const elements: EDNVal[] = [];
      for (let i = 0; i < count; i++) {
        const itemCursor = list.getCursor(i);
        if (itemCursor) {
          elements.push(cursorToEdnValue(itemCursor));
        }
      }
      return elements; // EDN vectors are plain arrays
    }

    case Tag.LINKED_ARRAY_LIST: {
      const elements: EDNVal[] = [];
      const iter = cursor.iterator();
      while (iter.hasNext()) {
        const itemCursor = iter.next();
        if (itemCursor) {
          elements.push(cursorToEdnValue(itemCursor));
        }
      }
      return { list: elements } as EDNList;
    }

    case Tag.HASH_MAP:
    case Tag.COUNTED_HASH_MAP: {
      const entries: [EDNVal, EDNVal][] = [];
      const iter = cursor.iterator();
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        if (kvPairCursor) {
          const kvPair = kvPairCursor.readKeyValuePair();
          const key = cursorToEdnValue(kvPair.keyCursor);
          const value = cursorToEdnValue(kvPair.valueCursor);
          entries.push([key, value]);
        }
      }
      return { map: entries } as EDNMap;
    }

    case Tag.HASH_SET:
    case Tag.COUNTED_HASH_SET: {
      const elements: EDNVal[] = [];
      const iter = cursor.iterator();
      while (iter.hasNext()) {
        const kvPairCursor = iter.next();
        if (kvPairCursor) {
          const kvPair = kvPairCursor.readKeyValuePair();
          elements.push(cursorToEdnValue(kvPair.keyCursor));
        }
      }
      return { set: elements } as EDNSet;
    }

    default:
      throw new Error(`Unsupported tag: ${tag}`);
  }
}

function parseKeyword(text: string): EDNKeyword {
  // Remove leading : if present
  const str = text.startsWith(':') ? text.slice(1) : text;
  return toKeyword(str);
}

// Type guards
function isEdnMap(value: EDNVal): value is EDNMap {
  return typeof value === 'object' && value !== null && 'map' in value;
}

function isEdnSet(value: EDNVal): value is EDNSet {
  return typeof value === 'object' && value !== null && 'set' in value;
}

function isEdnList(value: EDNVal): value is EDNList {
  return typeof value === 'object' && value !== null && 'list' in value;
}

function isEdnKeyword(value: EDNVal): value is EDNKeyword {
  return typeof value === 'object' && value !== null && 'key' in value;
}

function isEdnSymbol(value: EDNVal): value is EDNSymbol {
  return typeof value === 'object' && value !== null && 'sym' in value;
}

// Pretty print EDN with indentation
function prettyPrintEdn(value: EDNVal, indent: number): string {
  const spaces = '  '.repeat(indent);
  const innerSpaces = '  '.repeat(indent + 1);

  if (value === null) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toString();
    const str = value.toString();
    if (!str.includes('.') && !str.includes('e') && !str.includes('E')) {
      return str + '.0';
    }
    return str;
  }
  if (typeof value === 'bigint') return `${value}N`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Date) return `#inst "${value.toISOString()}"`;

  if (isEdnKeyword(value)) return `:${value.key}`;
  if (isEdnSymbol(value)) return value.sym;

  // Vector (array)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (isSimpleCollection(value)) {
      return `[${value.map(e => prettyPrintEdn(e, 0)).join(' ')}]`;
    }
    const items = value.map(e => innerSpaces + prettyPrintEdn(e, indent + 1));
    return `[\n${items.join('\n')}\n${spaces}]`;
  }

  // List
  if (isEdnList(value)) {
    if (value.list.length === 0) return '()';
    if (isSimpleCollection(value.list)) {
      return `(${value.list.map(e => prettyPrintEdn(e, 0)).join(' ')})`;
    }
    const items = value.list.map(e => innerSpaces + prettyPrintEdn(e, indent + 1));
    return `(\n${items.join('\n')}\n${spaces})`;
  }

  // Set
  if (isEdnSet(value)) {
    if (value.set.length === 0) return '#{}';
    if (isSimpleCollection(value.set)) {
      return `#{${value.set.map(e => prettyPrintEdn(e, 0)).join(' ')}}`;
    }
    const items = value.set.map(e => innerSpaces + prettyPrintEdn(e, indent + 1));
    return `#{\n${items.join('\n')}\n${spaces}}`;
  }

  // Map
  if (isEdnMap(value)) {
    if (value.map.length === 0) return '{}';
    const pairs = value.map.map(([k, v]) => {
      const keyStr = prettyPrintEdn(k, indent + 1);
      const valStr = prettyPrintEdn(v, indent + 1);
      return `${innerSpaces}${keyStr} ${valStr}`;
    });
    return `{\n${pairs.join('\n')}\n${spaces}}`;
  }

  // Fallback to library's toEDNString
  return toEDNString(value);
}

function isSimpleCollection(elements: EDNVal[]): boolean {
  if (elements.length > 5) return false;
  return elements.every(e =>
    e === null ||
    typeof e === 'boolean' ||
    typeof e === 'number' ||
    typeof e === 'bigint' ||
    typeof e === 'string' ||
    isEdnKeyword(e) ||
    isEdnSymbol(e)
  );
}

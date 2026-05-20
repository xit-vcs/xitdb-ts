# xitdb Database Dump Tool

A command-line tool for inspecting and dumping the contents of xitdb database files.

## Installation

First, build the xitdb library from the root directory:

```bash
# From the xitdb-ts root directory
npm run build
```

Then install the dump-database dependencies:

```bash
cd example/dump-database
npm install
```

## Usage

### Human-readable output (default)

```bash
npx tsx index.ts <database-file>
```

This displays the database structure in a hierarchical, indented format showing:
- Data types (ArrayList, HashMap, HashSet, LinkedArrayList, etc.)
- Collection sizes
- Key-value pairs
- Primitive values with their types

Example output:
```
Database: mydata.xdb
---
ArrayList[1]:
    HashMap{3}:
      "name":
        "Alice"
      "age":
        30 (int)
      "active":
        "true" (format: bl)
```

### JSON output

```bash
npx tsx index.ts --json <database-file>
```

Outputs the database content as formatted JSON, suitable for piping to other tools:

```bash
npx tsx index.ts --json mydata.xdb | jq '.users'
```

Example output:
```json
{
  "name": "Alice",
  "age": 30,
  "active": "true"
}
```

## Output Format Details

### Human-readable format

| xitdb Type | Display Format |
|------------|----------------|
| ArrayList | `ArrayList[count]:` |
| LinkedArrayList | `LinkedArrayList[count]:` |
| HashMap | `HashMap{count}:` |
| CountedHashMap | `CountedHashMap{count}:` |
| HashSet | `HashSet{count}: [items]` |
| CountedHashSet | `CountedHashSet{count}: [items]` |
| Bytes | `"text"` or `<N bytes: hex...>` |
| Bytes with format tag | `"text" (format: tag)` |
| UINT | `value (uint)` |
| INT | `value (int)` |
| FLOAT | `value (float)` |
| NONE | `(none)` |

### JSON format

- Arrays and lists become JSON arrays
- Maps become JSON objects
- Sets become JSON arrays
- Strings remain strings
- Numbers remain numbers
- Binary data becomes `{"_binary": "base64-encoded"}`
- Unknown tags become `{"_unknown": tag-number}`
- For root ArrayList (transaction history), only the latest entry is shown

## Testing

### Create a test database using impexp-edn

```bash
# From the impexp-edn directory
cd ../impexp-edn
npx tsx index.ts import_edn samples/simple.edn /tmp/test.xdb

# Then dump it
cd ../dump-database
npx tsx index.ts /tmp/test.xdb
npx tsx index.ts --json /tmp/test.xdb
```

### Test with various database files

```bash
# Human-readable dump
npx tsx index.ts /path/to/database.xdb

# JSON dump
npx tsx index.ts --json /path/to/database.xdb

# Pipe to jq for filtering
npx tsx index.ts --json /path/to/database.xdb | jq 'keys'
```

## Project Structure

```
example/dump-database/
├── package.json    # Package configuration
├── index.ts        # Main dump tool implementation
└── README.md       # This file
```

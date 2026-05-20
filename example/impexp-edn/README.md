# xitdb EDN Import/Export Tool

A command-line tool for importing EDN (Extensible Data Notation) files into xitdb databases and exporting xitdb databases as EDN.

## Installation

First, build the xitdb library from the root directory:

```bash
# From the xitdb-ts root directory
npm run build
```

Then install the impexp-edn dependencies:

```bash
cd example/impexp-edn
npm install
```

## Usage

### Import EDN to xitdb

```bash
npx tsx index.ts import_edn <input.edn> <output.xdb>
```

Example:
```bash
npx tsx index.ts import_edn samples/simple.edn mydata.xdb
```

### Export xitdb to EDN

```bash
npx tsx index.ts export_edn <input.xdb>
```

The EDN output is printed to stdout. To save to a file:
```bash
npx tsx index.ts export_edn mydata.xdb > output.edn
```

## EDN to xitdb Type Mapping

| EDN Type | xitdb Type | Notes |
|----------|------------|-------|
| `nil` | `Tag.NONE` | Empty slot |
| `true`/`false` | `Bytes` with format tag `"bl"` | Stored as "true"/"false" string |
| Integer | `Int` | Signed bigint |
| Float | `Float` | 64-bit floating point |
| String | `Bytes` | Plain string (no format tag) |
| Keyword `:name` | `Bytes` with format tag `"kw"` | Stored as `:name` or `:ns/name` |
| Symbol `name` | `Bytes` with format tag `"sy"` | Stored as `name` or `ns/name` |
| Vector `[...]` | `ArrayList` | Ordered, indexed collection |
| List `(...)` | `LinkedArrayList` | Ordered, linked collection |
| Set `#{...}` | `HashSet` | Unordered, unique elements |
| Map `{...}` | `HashMap` | Key-value pairs |

### Map Keys

Only string and keyword keys are supported for maps. Complex keys (vectors, maps, etc.) will throw an error.

## Sample Files

The `samples/` directory contains example EDN files:

- **simple.edn** - Basic key-value data
- **user-profile.edn** - User profile with nested data and namespaced keywords
- **todo-list.edn** - Todo application data with vectors and sets
- **inventory.edn** - Product inventory with deeply nested structures
- **all-types.edn** - Demonstrates all supported EDN types

## Running Tests

### Test all sample files

```bash
# From the impexp-edn directory
for f in samples/*.edn; do
  echo "=== Testing $f ==="
  npx tsx index.ts import_edn "$f" /tmp/test.xdb
  npx tsx index.ts export_edn /tmp/test.xdb
  echo
done
```

### Test round-trip fidelity

```bash
# Import, export, re-import, re-export - output should be identical
npx tsx index.ts import_edn samples/simple.edn /tmp/test1.xdb
npx tsx index.ts export_edn /tmp/test1.xdb > /tmp/output1.edn
npx tsx index.ts import_edn /tmp/output1.edn /tmp/test2.xdb
npx tsx index.ts export_edn /tmp/test2.xdb > /tmp/output2.edn
diff /tmp/output1.edn /tmp/output2.edn && echo "Round-trip successful!"
```

### Test a specific file

```bash
npx tsx index.ts import_edn samples/all-types.edn /tmp/test.xdb
npx tsx index.ts export_edn /tmp/test.xdb
```

## EDN Format Reference

EDN (Extensible Data Notation) is a subset of Clojure's data syntax. Key features:

- **Comments**: Start with `;` and continue to end of line
- **Commas**: Treated as whitespace (optional)
- **Discard**: `#_` discards the next form

Example EDN file:
```clojure
;; This is a comment
{
  :name "Alice"           ; Keywords start with :
  :age 30                 ; Integers
  :balance 1234.56        ; Floats
  :active true            ; Booleans
  :roles [:admin :user]   ; Vectors with keywords
  :tags #{"vip" "beta"}   ; Sets with strings
  :metadata {             ; Nested maps
    :created "2024-01-15"
    :modified nil         ; Nil value
  }
}
```

## Project Structure

```
example/impexp-edn/
├── package.json        # Package configuration
├── index.ts            # CLI entry point
├── import-edn.ts       # Import implementation
├── export-edn.ts       # Export implementation
├── edn/
│   ├── types.ts        # EDN AST type definitions
│   ├── parser.ts       # EDN tokenizer + recursive descent parser
│   └── serializer.ts   # xitdb cursor → EDN string serializer
├── samples/            # Sample EDN files
│   ├── simple.edn
│   ├── user-profile.edn
│   ├── todo-list.edn
│   ├── inventory.edn
│   └── all-types.edn
└── README.md           # This file
```

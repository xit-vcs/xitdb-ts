// Tag
export { Tag, tagValueOf } from './tag.js';

// Slot
export { Slot } from './slot.js';
export { SlotPointer } from './slot-pointer.js';
export type { Slotted } from './slotted.js';

// Writeable Data
export { Uint, Int, Float, Bytes, type WriteableData } from './writeable-data.js';

// Exceptions
export {
  DatabaseException,
  NotImplementedException,
  UnreachableException,
  InvalidDatabaseException,
  InvalidVersionException,
  InvalidHashSizeException,
  KeyNotFoundException,
  WriteNotAllowedException,
  UnexpectedTagException,
  CursorNotWriteableException,
  ExpectedTxStartException,
  KeyOffsetExceededException,
  PathPartMustBeAtEndException,
  StreamTooLongException,
  EndOfStreamException,
  InvalidOffsetException,
  InvalidTopLevelTypeException,
  ExpectedUnsignedLongException,
  NoAvailableSlotsException,
  MustSetNewSlotsToFullException,
  EmptySlotException,
  ExpectedRootNodeException,
  InvalidFormatTagSizeException,
  UnexpectedWriterPositionException,
  MaxShiftExceededException,
} from './exceptions.js';

// Core
export type { Core, DataReader, DataWriter } from './core.js';
export { CoreMemory } from './core-memory.js';
export { CoreFile } from './core-file.js';
export { CoreBufferedFile } from './core-buffered-file.js';
export { Hasher } from './hasher.js';

// Database
export {
  Database,
  WriteMode,
  Header,
  ArrayListHeader,
  TopLevelArrayListHeader,
  BTreeHeader,
  KeyValuePair,
  BTreeNode,
  BTreeNodeKind,
  BTreeNodeRef,
  BTreeInsertResult,
  BTreeWriteSlot,
  BTreeJoinResult,
  BTreeSplitResult,
  VERSION,
  MAGIC_NUMBER,
  BIT_COUNT,
  SLOT_COUNT,
  MASK,
  INDEX_BLOCK_SIZE,
  MAX_BRANCH_LENGTH,
  BTREE_SLOT_COUNT,
  BTREE_SPLIT_COUNT,
  BTREE_NODE_HEADER_SIZE,
  BTREE_LEAF_BLOCK_SIZE,
  BTREE_BRANCH_BLOCK_SIZE,
  // PathParts
  type PathPart,
  ArrayListInit,
  ArrayListGet,
  ArrayListAppend,
  ArrayListSlice,
  LinkedArrayListInit,
  LinkedArrayListGet,
  LinkedArrayListAppend,
  LinkedArrayListSlice,
  LinkedArrayListConcat,
  LinkedArrayListInsert,
  LinkedArrayListRemove,
  HashMapInit,
  HashMapGet,
  HashMapRemove,
  WriteData,
  Context,
  // HashMapGetTarget
  type HashMapGetTarget,
  HashMapGetKVPair,
  HashMapGetKey,
  HashMapGetValue,
  type ContextFunction,
} from './database.js';

// Cursors
export { ReadCursor, Reader, CursorIterator, KeyValuePairCursor } from './read-cursor.js';
export { WriteCursor, Writer, WriteCursorIterator, WriteKeyValuePairCursor } from './write-cursor.js';

// Collections
export { ReadArrayList } from './read-array-list.js';
export { WriteArrayList } from './write-array-list.js';
export { ReadHashMap } from './read-hash-map.js';
export { WriteHashMap } from './write-hash-map.js';
export { ReadHashSet } from './read-hash-set.js';
export { WriteHashSet } from './write-hash-set.js';
export { ReadLinkedArrayList } from './read-linked-array-list.js';
export { WriteLinkedArrayList } from './write-linked-array-list.js';
export { ReadCountedHashMap } from './read-counted-hash-map.js';
export { WriteCountedHashMap } from './write-counted-hash-map.js';
export { ReadCountedHashSet } from './read-counted-hash-set.js';
export { WriteCountedHashSet } from './write-counted-hash-set.js';

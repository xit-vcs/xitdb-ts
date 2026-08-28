export class DatabaseException extends Error {
  constructor(message?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotImplementedException extends DatabaseException {}
export class UnreachableException extends DatabaseException {}
export class InvalidDatabaseException extends DatabaseException {}
export class TruncatedDatabaseException extends DatabaseException {}
export class InvalidVersionException extends DatabaseException {}
export class InvalidHashSizeException extends DatabaseException {}
export class KeyNotFoundException extends DatabaseException {}
export class WriteNotAllowedException extends DatabaseException {}
export class UnexpectedTagException extends DatabaseException {}
export class CursorNotWriteableException extends DatabaseException {}
export class ExpectedTxStartException extends DatabaseException {}
export class KeyOffsetExceededException extends DatabaseException {}
export class PathPartMustBeAtEndException extends DatabaseException {}
export class StreamTooLongException extends DatabaseException {}
export class EndOfStreamException extends DatabaseException {}
export class InvalidOffsetException extends DatabaseException {}
export class InvalidTopLevelTypeException extends DatabaseException {}
export class ExpectedUnsignedLongException extends DatabaseException {}
export class NoAvailableSlotsException extends DatabaseException {}
export class MustSetNewSlotsToFullException extends DatabaseException {}
export class EmptySlotException extends DatabaseException {}
export class ExpectedRootNodeException extends DatabaseException {}
export class InvalidFormatTagSizeException extends DatabaseException {}
export class UnexpectedWriterPositionException extends DatabaseException {}
export class MaxShiftExceededException extends DatabaseException {}
export class InvalidBTreeNodeException extends DatabaseException {}
export class InvalidBTreeNodeKindException extends DatabaseException {}
export class Uint64OverflowException extends DatabaseException {}
export class Int64OverflowException extends DatabaseException {}

/**
 * maps source offsets to target offsets during compaction.
 * mappings must remain available until cleared to preserve sharing and cycles.
 * each map requires exclusive use during compaction.
 */
export interface OffsetMap {
  /** clears mappings from the previous compaction. */
  clear(): void;

  /** returns the target offset, or undefined if the source offset is absent. */
  get(sourceOffset: number): number | undefined;

  /** records where the source object was copied. */
  set(sourceOffset: number, targetOffset: number): void;
}

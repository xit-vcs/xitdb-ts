export const enum Tag {
  NONE = 0,
  INDEX = 1,
  ARRAY_LIST = 2,
  LINKED_ARRAY_LIST = 3,
  HASH_MAP = 4,
  KV_PAIR = 5,
  BYTES = 6,
  SHORT_BYTES = 7,
  UINT = 8,
  INT = 9,
  FLOAT = 10,
  HASH_SET = 11,
  COUNTED_HASH_MAP = 12,
  COUNTED_HASH_SET = 13,
  SORTED_MAP = 14,
  SORTED_SET = 15,
}

export function tagValueOf(n: number): Tag {
  if (n < 0 || n > 15) {
    throw new Error(`Invalid tag value: ${n}`);
  }
  return n as Tag;
}

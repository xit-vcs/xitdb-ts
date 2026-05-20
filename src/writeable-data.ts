import { InvalidFormatTagSizeException, Uint64OverflowException, Int64OverflowException } from './exceptions.js';

export interface WriteableData {}

const UINT64_MAX = 2n ** 64n - 1n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export class Uint implements WriteableData {
  readonly value: bigint;

  constructor(value: number | bigint) {
    const bigintValue = BigInt(value);
    if (bigintValue < 0n || bigintValue > UINT64_MAX) {
      throw new Uint64OverflowException();
    }
    this.value = bigintValue;
  }
}

export class Int implements WriteableData {
  readonly value: bigint;

  constructor(value: number | bigint) {
    const bigintValue = BigInt(value);
    if (bigintValue < INT64_MIN || bigintValue > INT64_MAX) {
      throw new Int64OverflowException();
    }
    this.value = bigintValue;
  }
}

export class Float implements WriteableData {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}

export class Bytes implements WriteableData {
  readonly value: Uint8Array;
  readonly formatTag: Uint8Array | null;

  constructor(value: Uint8Array | string, formatTag?: Uint8Array | string | null) {
    if (typeof value === 'string') {
      this.value = new TextEncoder().encode(value);
    } else {
      this.value = value;
    }

    if (formatTag === undefined || formatTag === null) {
      this.formatTag = null;
    } else if (typeof formatTag === 'string') {
      const encoded = new TextEncoder().encode(formatTag);
      if (encoded.length !== 2) {
        throw new InvalidFormatTagSizeException();
      }
      this.formatTag = encoded;
    } else {
      if (formatTag.length !== 2) {
        throw new InvalidFormatTagSizeException();
      }
      this.formatTag = formatTag;
    }
  }

  isShort(): boolean {
    const totalSize = this.formatTag !== null ? 6 : 8;
    if (this.value.length > totalSize) return false;
    for (const b of this.value) {
      if (b === 0) return false;
    }
    return true;
  }
}

import { Tag, tagValueOf } from './tag.js';
import type { WriteableData } from './writeable-data.js';

export class Slot implements WriteableData {
  static readonly LENGTH = 9;

  readonly value: bigint;
  readonly tag: Tag;
  readonly full: boolean;

  constructor(value: number | bigint = 0n, tag: Tag = Tag.NONE, full: boolean = false) {
    this.value = typeof value === 'bigint' ? value : BigInt(value);
    this.tag = tag;
    this.full = full;
  }

  withTag(tag: Tag): Slot {
    return new Slot(this.value, tag, this.full);
  }

  withFull(full: boolean): Slot {
    return new Slot(this.value, this.tag, full);
  }

  empty(): boolean {
    return this.tag === Tag.NONE && !this.full;
  }

  toBytes(): Uint8Array {
    const buffer = new ArrayBuffer(Slot.LENGTH);
    const view = new DataView(buffer);
    let tagInt = this.full ? 0b1000_0000 : 0;
    tagInt = tagInt | this.tag;
    view.setUint8(0, tagInt);
    view.setBigInt64(1, this.value, false);
    return new Uint8Array(buffer);
  }

  static fromBytes(bytes: Uint8Array): Slot {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tagByte = view.getUint8(0);
    const full = (tagByte & 0b1000_0000) !== 0;
    const tag = tagValueOf(tagByte & 0b0111_1111);
    const value = view.getBigInt64(1, false);
    return new Slot(value, tag, full);
  }

  equals(other: Slot): boolean {
    return this.value === other.value && this.tag === other.tag && this.full === other.full;
  }
}

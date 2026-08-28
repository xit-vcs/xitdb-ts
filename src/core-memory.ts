import type { Core, DataReader, DataWriter } from './core.js';

export class CoreMemory implements Core {
  public memory: RandomAccessMemory;

  constructor() {
    this.memory = new RandomAccessMemory();
  }

  reader(): DataReader {
    return this.memory;
  }

  writer(): DataWriter {
    return this.memory;
  }

  length(): number {
    return this.memory.size();
  }

  seek(pos: number): void {
    this.memory.seek(pos);
  }

  position(): number {
    return this.memory.getPosition();
  }

  setLength(len: number): void {
    this.memory.setLength(len);
  }

  flush(): void {
    // no-op for in-memory
  }

  sync(): void {
    // no-op for in-memory
  }

  [Symbol.dispose](): void {
  }
}

class RandomAccessMemory implements DataReader, DataWriter {
  private buffer: Uint8Array;
  private _position: number = 0;
  private _count: number = 0;

  constructor(initialSize: number = 1024) {
    this.buffer = new Uint8Array(initialSize);
  }

  private ensureCapacity(minCapacity: number): void {
    if (minCapacity > this.buffer.length) {
      let newCapacity = this.buffer.length * 2;
      if (newCapacity < minCapacity) {
        newCapacity = minCapacity;
      }
      const newBuffer = new Uint8Array(newCapacity);
      newBuffer.set(this.buffer.subarray(0, this._count));
      this.buffer = newBuffer;
    }
  }

  size(): number {
    return this._count;
  }

  seek(pos: number): void {
    if (pos > this._count) {
      this._position = this._count;
    } else {
      this._position = pos;
    }
  }

  getPosition(): number {
    return this._position;
  }

  setLength(len: number): void {
    if (len === 0) {
      this.reset();
    } else {
      if (len > this._count) throw new Error('Cannot extend length');
      this._count = len;
      if (this._position > len) {
        this._position = len;
      }
    }
  }

  reset(): void {
    this._count = 0;
    this._position = 0;
  }

  toByteArray(): Uint8Array {
    return this.buffer.slice(0, this._count);
  }

  // DataWriter interface
  write(data: Uint8Array): void {
    const pos = this._position;
    if (pos < this._count) {
      const bytesBeforeEnd = Math.min(data.length, this._count - pos);
      for (let i = 0; i < bytesBeforeEnd; i++) {
        this.buffer[pos + i] = data[i];
      }

      if (bytesBeforeEnd < data.length) {
        const bytesAfterEnd = data.length - bytesBeforeEnd;
        this.ensureCapacity(this._count + bytesAfterEnd);
        this.buffer.set(data.subarray(bytesBeforeEnd), this._count);
        this._count += bytesAfterEnd;
      }
    } else {
      this.ensureCapacity(this._count + data.length);
      this.buffer.set(data, this._count);
      this._count += data.length;
    }

    this._position = pos + data.length;
  }

  writeByte(v: number): void {
    this.write(new Uint8Array([v & 0xff]));
  }

  writeShort(v: number): void {
    const buffer = new ArrayBuffer(2);
    const view = new DataView(buffer);
    view.setInt16(0, v, false); // big-endian
    this.write(new Uint8Array(buffer));
  }

  writeLong(v: number): void {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setBigInt64(0, BigInt(v), false);
    this.write(new Uint8Array(buffer));
  }

  // DataReader interface
  readFully(b: Uint8Array): void {
    const pos = this._position;
    if (pos + b.length > this._count) {
      throw new Error('End of stream');
    }
    b.set(this.buffer.subarray(pos, pos + b.length));
    this._position = pos + b.length;
  }

  readByte(): number {
    const bytes = new Uint8Array(1);
    this.readFully(bytes);
    return bytes[0];
  }

  readShort(): number {
    const bytes = new Uint8Array(2);
    this.readFully(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getInt16(0, false); // big-endian
  }

  readInt(): number {
    const bytes = new Uint8Array(4);
    this.readFully(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getInt32(0, false); // big-endian
  }

  readLong(): number {
    const bytes = new Uint8Array(8);
    this.readFully(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Number(view.getBigInt64(0, false));
  }
}

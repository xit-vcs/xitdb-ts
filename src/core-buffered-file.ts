import type { Core, DataReader, DataWriter } from './core.js';
import { CoreFile } from './core-file.js';
import { CoreMemory } from './core-memory.js';

export class CoreBufferedFile implements Core {
  public file: RandomAccessBufferedFile;

  constructor(filePath: string, bufferSize?: number) {
    this.file = new RandomAccessBufferedFile(filePath, bufferSize);
  }

  reader(): DataReader {
    return this.file;
  }

  writer(): DataWriter {
    return this.file;
  }

  length(): number {
    return this.file.length();
  }

  seek(pos: number): void {
    this.file.seek(pos);
  }

  position(): number {
    return this.file.position();
  }

  setLength(len: number): void {
    this.file.setLength(len);
  }

  flush(): void {
    this.file.flush();
  }

  sync(): void {
    this.file.sync();
  }

  [Symbol.dispose](): void {
    this.file[Symbol.dispose]();
  }
}

const DEFAULT_BUFFER_SIZE = 8 * 1024 * 1024; // 8MB

class RandomAccessBufferedFile implements DataReader, DataWriter, Disposable {
  public file: CoreFile;
  private memory: CoreMemory;
  private bufferSize: number; // flushes when the memory is >= this size
  private filePos: number;
  private memoryPos: number;

  constructor(filePath: string, bufferSize: number = DEFAULT_BUFFER_SIZE) {
    this.file = new CoreFile(filePath);
    this.memory = new CoreMemory();
    this.bufferSize = bufferSize;
    this.filePos = 0;
    this.memoryPos = 0;
  }

  seek(pos: number): void {
    // flush if we are going past the end of the in-memory buffer
    if (pos > this.memoryPos + this.memory.length()) {
      this.flush();
    }

    this.filePos = pos;

    // if the buffer is empty, set its position to this offset as well
    if (this.memory.length() === 0) {
      this.memoryPos = pos;
    }
  }

  length(): number {
    return Math.max(this.memoryPos + this.memory.length(), this.file.length());
  }

  position(): number {
    return this.filePos;
  }

  setLength(len: number): void {
    this.flush();
    this.file.setLength(len);
    this.filePos = Math.min(len, this.filePos);
  }

  flush(): void {
    if (this.memory.length() > 0) {
      this.file.seek(this.memoryPos);
      this.file.writer().write(this.memory.memory.toByteArray());

      this.memoryPos = 0;
      this.memory.memory.reset();
    }
  }

  sync(): void {
    this.flush();
    this.file.sync();
  }

  [Symbol.dispose](): void {
    this.flush();
    this.file[Symbol.dispose]();
  }

  // DataWriter interface

  write(buffer: Uint8Array): void {
    if (this.memory.length() + buffer.length > this.bufferSize) {
      this.flush();
    }

    if (this.filePos >= this.memoryPos && this.filePos <= this.memoryPos + this.memory.length()) {
      this.memory.seek(this.filePos - this.memoryPos);
      this.memory.memory.write(buffer);
    } else {
      // a direct disk write that overlaps the buffered region would be
      // clobbered by a later flush of stale buffer bytes, so flush first
      if (this.filePos < this.memoryPos + this.memory.length() && this.filePos + buffer.length > this.memoryPos) {
        this.flush();
      }
      // Write directly to file
      this.file.seek(this.filePos);
      this.file.writer().write(buffer);
    }

    this.filePos += buffer.length;
  }

  writeByte(v: number): void {
    this.write(new Uint8Array([v & 0xff]));
  }

  writeShort(v: number): void {
    const buffer = new ArrayBuffer(2);
    const view = new DataView(buffer);
    view.setInt16(0, v & 0xffff, false); // big-endian
    this.write(new Uint8Array(buffer));
  }

  writeLong(v: number): void {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setBigInt64(0, BigInt(v), false);
    this.write(new Uint8Array(buffer));
  }

  // DataReader interface

  readFully(buffer: Uint8Array): void {
    let pos = 0;

    // read from the disk -- before the in-memory buffer
    if (this.filePos < this.memoryPos) {
      const sizeBeforeMem = Math.min(this.memoryPos - this.filePos, buffer.length);
      const tempBuffer = new Uint8Array(sizeBeforeMem);
      this.file.seek(this.filePos);
      this.file.reader().readFully(tempBuffer);
      buffer.set(tempBuffer, pos);
      pos += sizeBeforeMem;
      this.filePos += sizeBeforeMem;
    }

    if (pos === buffer.length) return;

    // read from the in-memory buffer
    if (this.filePos >= this.memoryPos && this.filePos < this.memoryPos + this.memory.length()) {
      const memPos = this.filePos - this.memoryPos;
      const sizeInMem = Math.min(this.memory.length() - memPos, buffer.length - pos);
      this.memory.seek(memPos);
      const memBuffer = new Uint8Array(sizeInMem);
      this.memory.memory.readFully(memBuffer);
      buffer.set(memBuffer, pos);
      pos += sizeInMem;
      this.filePos += sizeInMem;
    }

    if (pos === buffer.length) return;

    // read from the disk -- after the in-memory buffer
    if (this.filePos >= this.memoryPos + this.memory.length()) {
      const sizeAfterMem = buffer.length - pos;
      const tempBuffer = new Uint8Array(sizeAfterMem);
      this.file.seek(this.filePos);
      this.file.reader().readFully(tempBuffer);
      buffer.set(tempBuffer, pos);
      pos += sizeAfterMem;
      this.filePos += sizeAfterMem;
    }
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

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
  private bufferSize: number; // flushes before the memory would grow beyond this size
  private filePos: number;
  private memoryPos: number;
  // the file's length, cached so that `length` doesn't need to ask the OS
  // every time data is allocated. another process may write to the file
  // whenever this one isn't, so it is only set once we begin writing, and
  // it is cleared when the writes are flushed.
  private fileLen: number | null = null;

  constructor(filePath: string, bufferSize: number = DEFAULT_BUFFER_SIZE) {
    this.file = new CoreFile(filePath);
    this.memory = new CoreMemory();
    this.bufferSize = bufferSize;
    this.filePos = 0;
    this.memoryPos = 0;
  }

  seek(pos: number): void {
    this.filePos = pos;
  }

  length(): number {
    const fileLen = this.fileLen ?? this.file.length();
    const bufferSize = this.memory.length();
    // a failed allocation or a rollback can leave an empty
    // buffer positioned beyond the file's end.
    if (bufferSize === 0) return fileLen;
    return Math.max(this.memoryPos + bufferSize, fileLen);
  }

  position(): number {
    return this.filePos;
  }

  setLength(len: number): void {
    // discard buffered bytes past the new end rather than flushing them.
    // a rollback must not depend on writing the data it is throwing away,
    // because that write may be what failed (e.g. the disk is full).
    if (len <= this.memoryPos) {
      this.memory.memory.reset();
    } else if (len < this.memoryPos + this.memory.length()) {
      this.memory.memory.setLength(len - this.memoryPos);
    }
    this.fileLen = null;
    this.file.setLength(len);
    this.filePos = Math.min(len, this.filePos);
  }

  flush(): void {
    this.fileLen = null;
    if (this.memory.length() > 0) {
      this.writeToFile(this.memoryPos, this.memory.memory.toByteArray());
      this.memory.memory.reset();
    }
  }

  private writeToFile(pos: number, buffer: Uint8Array): void {
    // if the write fails partway, the file's length is unknown
    const fileLen = this.fileLen;
    this.fileLen = null;

    this.file.seek(pos);
    this.file.writer().write(buffer);

    if (fileLen !== null) this.fileLen = Math.max(fileLen, pos + buffer.length);
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
    if (buffer.length === 0) return;

    // the in-memory buffer is a single contiguous window of the file
    // starting at memoryPos. start a new window at this position if
    // the buffer is empty, the write is past the end of the window,
    // or the write would grow the window beyond the max size.
    const memorySize = this.memory.length();
    if (
      memorySize === 0 ||
      this.filePos > this.memoryPos + memorySize ||
      (this.filePos >= this.memoryPos && this.filePos - this.memoryPos + buffer.length > this.bufferSize)
    ) {
      this.flush();
      this.memoryPos = this.filePos;
    }

    if (this.fileLen === null) {
      this.fileLen = this.file.length();
    }

    if (this.filePos >= this.memoryPos && this.filePos - this.memoryPos + buffer.length <= this.bufferSize) {
      // write to the in-memory buffer
      this.memory.seek(this.filePos - this.memoryPos);
      this.memory.memory.write(buffer);
    } else {
      // a direct disk write that overlaps the buffered region would be
      // clobbered by a later flush of stale buffer bytes, so flush first
      if (this.filePos < this.memoryPos + this.memory.length() && this.filePos + buffer.length > this.memoryPos) {
        this.flush();
      }
      this.writeToFile(this.filePos, buffer);
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

import type { Core, DataReader, DataWriter } from './core.js';
import * as fs from 'fs';

export class CoreFile implements Core {
  public filePath: string;
  private _position: number = 0;
  public fd: number;

  constructor(filePath: string) {
    this.filePath = filePath;
    // Create file if it doesn't exist
    try {
      fs.accessSync(filePath);
    } catch {
      fs.writeFileSync(filePath, new Uint8Array(0));
    }
    // Open file for reading and writing
    this.fd = fs.openSync(filePath, 'r+');
  }

  reader(): DataReader {
    return new FileDataReader(this);
  }

  writer(): DataWriter {
    return new FileDataWriter(this);
  }

  length(): number {
    const stats = fs.fstatSync(this.fd);
    return stats.size;
  }

  seek(pos: number): void {
    this._position = pos;
  }

  position(): number {
    return this._position;
  }

  setLength(len: number): void {
    fs.ftruncateSync(this.fd, len);
  }

  flush(): void {
  }

  sync(): void {
    fs.fsyncSync(this.fd);
  }

  [Symbol.dispose]() {
    fs.closeSync(this.fd);
  }
}

class FileDataReader implements DataReader {
  private core: CoreFile;

  constructor(core: CoreFile) {
    this.core = core;
  }

  readFully(b: Uint8Array): void {
    const position = this.core.position();
    fs.readSync(this.core.fd, b, 0, b.length, position);
    this.core.seek(position + b.length);
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
    return view.getInt16(0, false);
  }

  readInt(): number {
    const bytes = new Uint8Array(4);
    this.readFully(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getInt32(0, false);
  }

  readLong(): number {
    const bytes = new Uint8Array(8);
    this.readFully(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Number(view.getBigInt64(0, false));
  }
}

class FileDataWriter implements DataWriter {
  private core: CoreFile;

  constructor(core: CoreFile) {
    this.core = core;
  }

  write(buffer: Uint8Array): void {
    const position = this.core.position();
    fs.writeSync(this.core.fd, buffer, 0, buffer.length, position);
    this.core.seek(position + buffer.length);
  }

  writeByte(v: number): void {
    this.write(new Uint8Array([v & 0xff]));
  }

  writeShort(v: number): void {
    const buffer = new ArrayBuffer(2);
    const view = new DataView(buffer);
    view.setInt16(0, v, false);
    this.write(new Uint8Array(buffer));
  }

  writeLong(v: number): void {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setBigInt64(0, BigInt(v), false);
    this.write(new Uint8Array(buffer));
  }
}

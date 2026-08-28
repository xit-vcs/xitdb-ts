export interface DataReader {
  readFully(buffer: Uint8Array): void;
  readByte(): number;
  readShort(): number;
  readInt(): number;
  readLong(): number;
}

export interface DataWriter {
  write(buffer: Uint8Array): void;
  writeByte(v: number): void;
  writeShort(v: number): void;
  writeLong(v: number): void;
}

export interface Core extends Disposable {
  reader(): DataReader;
  writer(): DataWriter;
  length(): number;
  seek(pos: number): void;
  position(): number;
  setLength(len: number): void;
  flush(): void;
  sync(): void;
}

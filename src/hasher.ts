import { createHash } from 'crypto';

export class Hasher {
  readonly algorithm: string;
  readonly nodeAlgorithm: string;
  readonly id: number;
  readonly digestLength: number;

  constructor(algorithm: string, id: number = 0) {
    this.algorithm = algorithm;
    this.id = id;
    // Determine digest length and node algorithm name based on algorithm
    switch (algorithm) {
      case 'SHA-1':
        this.digestLength = 20;
        this.nodeAlgorithm = 'sha1';
        break;
      case 'SHA-256':
        this.digestLength = 32;
        this.nodeAlgorithm = 'sha256';
        break;
      case 'SHA-384':
        this.digestLength = 48;
        this.nodeAlgorithm = 'sha384';
        break;
      case 'SHA-512':
        this.digestLength = 64;
        this.nodeAlgorithm = 'sha512';
        break;
      default:
        throw new Error(`Unsupported hash algorithm: ${algorithm}`);
    }
  }

  digest(data: Uint8Array): Uint8Array {
    return new Uint8Array(createHash(this.nodeAlgorithm).update(data).digest());
  }

  static stringToId(hashIdName: string): number {
    const bytes = new TextEncoder().encode(hashIdName);
    if (bytes.length !== 4) {
      throw new Error('Name must be exactly four bytes long');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getInt32(0, false); // big-endian
  }

  static idToString(id: number): string {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setInt32(0, id, false); // big-endian
    return new TextDecoder().decode(new Uint8Array(buffer));
  }
}

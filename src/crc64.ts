// CRC-64/XZ: reflected, polynomial 0x42F0E1EBA9EA3693 (0xC96C5795D7870F42 reflected),
// init and xorout 0xFFFFFFFFFFFFFFFF. the check value of "123456789" is 0x995DC9BBDF1939FA.

const MASK_64 = 0xFFFF_FFFF_FFFF_FFFFn;
const POLYNOMIAL = 0xC96C_5795_D787_0F42n;

const TABLE: bigint[] = (() => {
  const table: bigint[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = BigInt(i);
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1n) !== 0n ? (crc >> 1n) ^ POLYNOMIAL : crc >> 1n;
    }
    table[i] = crc;
  }
  return table;
})();

export function crc64(bytes: Uint8Array): bigint {
  let crc = MASK_64;
  for (const b of bytes) {
    crc = TABLE[Number((crc ^ BigInt(b)) & 0xFFn)] ^ (crc >> 8n);
  }
  return crc ^ MASK_64;
}

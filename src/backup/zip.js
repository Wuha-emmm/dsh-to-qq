/**
 * Minimal ZIP reader/writer built on `node:zlib`.
 *
 * The bridge has no runtime dependencies, so the backup feature cannot pull in
 * `archiver` or `yauzl`. The subset implemented here is the one a backup needs:
 * store and deflate entries, UTF-8 names, and a central directory. ZIP64 and
 * encryption are deliberately unsupported; both are rejected loudly instead of
 * producing a file that silently fails to open elsewhere.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** Files above this size are not something a config backup should contain. */
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

/** The whole archive is read into memory, so keep it bounded. */
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

/** CRC-32 lookup table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buffer Bytes to checksum.
 * @returns {number} CRC-32.
 */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Convert a date to the DOS date/time pair ZIP stores.
 *
 * @param {Date} date Source date.
 * @returns {{ time: number, date: number }} Packed DOS fields.
 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/** Entries that are already compressed: deflating them again only costs time. */
const STORE_ONLY = /\.(jpe?g|png|gif|webp|zip|gz|zst|mp3|mp4|ogg|woff2?)$/i;

/**
 * Build a ZIP archive in memory.
 *
 * @param {{ name: string, data: Buffer, date?: Date, compress?: boolean }[]} entries Files to add.
 * @returns {Buffer} The archive bytes.
 */
export function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name ?? '').replace(/\\/g, '/');
    if (name === '' || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`refusing unsafe zip entry: ${name}`);
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`zip entry too large: ${name}`);
    const { time, date } = dosDateTime(entry.date ?? new Date());
    const compress = entry.compress ?? !STORE_ONLY.test(name);
    const deflated = compress && data.length > 0 ? deflateRawSync(data, { level: 6 }) : null;
    const method = deflated !== null && deflated.length < data.length ? 8 : 0;
    const body = method === 8 ? deflated : data;
    const checksum = crc32(data);
    const nameBytes = Buffer.from(name, 'utf8');

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);

    local.push(header, nameBytes, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);

    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuffer, end]);
}

/**
 * Find the End Of Central Directory record.
 *
 * @param {Buffer} buffer Archive bytes.
 * @returns {number} Offset of the EOCD signature, or -1.
 */
function findEnd(buffer) {
  const earliest = Math.max(0, buffer.length - 66_000);
  for (let index = buffer.length - 22; index >= earliest; index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

/**
 * Parse a ZIP archive into its entries.
 *
 * @param {Buffer} buffer Archive bytes.
 * @returns {Map<string, Buffer>} Entry name to uncompressed bytes.
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('zip: expected a buffer');
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('zip: archive is too large');
  const end = findEnd(buffer);
  if (end === -1) throw new Error('zip: not a zip archive (no end record)');

  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('zip: ZIP64 archives are not supported');
  }
  if (directoryOffset + directorySize > buffer.length) throw new Error('zip: truncated central directory');

  /** @type {Map<string, Buffer>} */
  const files = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length) throw new Error('zip: truncated central directory');
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('zip: bad central directory record');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if ((flags & 0x0001) !== 0) throw new Error(`zip: encrypted entry is not supported (${name})`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip: ZIP64 entries are not supported');
    }
    if (size > MAX_ENTRY_BYTES) throw new Error(`zip: entry too large (${name})`);
    if (localOffset + 30 > buffer.length) throw new Error(`zip: truncated local header (${name})`);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) throw new Error(`zip: truncated data (${name})`);

    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: unsupported compression method ${method} (${name})`);
    if (data.length !== size) throw new Error(`zip: size mismatch (${name})`);
    if (crc32(data) !== checksum) throw new Error(`zip: checksum mismatch (${name})`);
    if (files.has(name)) throw new Error(`zip: duplicate entry (${name})`);
    files.set(name, data);

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

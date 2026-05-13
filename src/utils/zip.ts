import { createReadStream } from 'node:fs';

export interface ZipEntry {
  name: string;
  path: string;
  size: number;
}

interface CentralEntry {
  name: Buffer;
  crc: number;
  size: bigint;
  offset: bigint;
}

const ZIP64_VERSION = 45;
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808;
const STORE_METHOD = 0;
const ZIP64_SIZE_PLACEHOLDER = 0xffffffff;

const crcTable = makeCrcTable();

export async function* streamZip(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const centralEntries: CentralEntry[] = [];
  let offset = 0n;
  const { time, date } = dosTimestamp(new Date());

  for (const entry of entries) {
    const name = Buffer.from(safeZipName(entry.name), 'utf8');
    const localOffset = offset;
    const localHeader = createLocalHeader(name, time, date);
    yield localHeader;
    offset += BigInt(localHeader.length);

    let crc = 0xffffffff;
    let size = 0n;
    for await (const chunk of createReadStream(entry.path)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = updateCrc(crc, buffer);
      size += BigInt(buffer.length);
      offset += BigInt(buffer.length);
      yield buffer;
    }
    crc = (crc ^ 0xffffffff) >>> 0;

    const descriptor = createZip64DataDescriptor(crc, size);
    yield descriptor;
    offset += BigInt(descriptor.length);
    centralEntries.push({ name, crc, size, offset: localOffset });
  }

  const centralOffset = offset;
  for (const entry of centralEntries) {
    const centralHeader = createCentralHeader(entry, time, date);
    yield centralHeader;
    offset += BigInt(centralHeader.length);
  }
  const centralSize = offset - centralOffset;
  const zip64EndOffset = offset;
  const zip64End = createZip64EndOfCentralDirectory(centralEntries.length, centralSize, centralOffset);
  yield zip64End;
  offset += BigInt(zip64End.length);

  const zip64Locator = createZip64Locator(zip64EndOffset);
  yield zip64Locator;
  offset += BigInt(zip64Locator.length);

  yield createEndOfCentralDirectory();
}

function createLocalHeader(name: Buffer, time: number, date: number): Buffer {
  const extra = createZip64Extra([0n, 0n]);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP64_VERSION, 4);
  header.writeUInt16LE(UTF8_DATA_DESCRIPTOR_FLAGS, 6);
  header.writeUInt16LE(STORE_METHOD, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(ZIP64_SIZE_PLACEHOLDER, 18);
  header.writeUInt32LE(ZIP64_SIZE_PLACEHOLDER, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, name, extra]);
}

function createZip64DataDescriptor(crc: number, size: bigint): Buffer {
  const descriptor = Buffer.alloc(24);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeBigUInt64LE(size, 8);
  descriptor.writeBigUInt64LE(size, 16);
  return descriptor;
}

function createCentralHeader(entry: CentralEntry, time: number, date: number): Buffer {
  const extra = createZip64Extra([entry.size, entry.size, entry.offset]);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(ZIP64_VERSION, 4);
  header.writeUInt16LE(ZIP64_VERSION, 6);
  header.writeUInt16LE(UTF8_DATA_DESCRIPTOR_FLAGS, 8);
  header.writeUInt16LE(STORE_METHOD, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(ZIP64_SIZE_PLACEHOLDER, 20);
  header.writeUInt32LE(ZIP64_SIZE_PLACEHOLDER, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(ZIP64_SIZE_PLACEHOLDER, 42);
  return Buffer.concat([header, entry.name, extra]);
}

function createZip64EndOfCentralDirectory(entryCount: number, centralSize: bigint, centralOffset: bigint): Buffer {
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(ZIP64_VERSION, 12);
  record.writeUInt16LE(ZIP64_VERSION, 14);
  record.writeUInt32LE(0, 16);
  record.writeUInt32LE(0, 20);
  record.writeBigUInt64LE(BigInt(entryCount), 24);
  record.writeBigUInt64LE(BigInt(entryCount), 32);
  record.writeBigUInt64LE(centralSize, 40);
  record.writeBigUInt64LE(centralOffset, 48);
  return record;
}

function createZip64Locator(zip64EndOffset: bigint): Buffer {
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(zip64EndOffset, 8);
  locator.writeUInt32LE(1, 16);
  return locator;
}

function createEndOfCentralDirectory(): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(0xffff, 8);
  record.writeUInt16LE(0xffff, 10);
  record.writeUInt32LE(ZIP64_SIZE_PLACEHOLDER, 12);
  record.writeUInt32LE(ZIP64_SIZE_PLACEHOLDER, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function createZip64Extra(values: bigint[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(value, 4 + index * 8));
  return extra;
}

function safeZipName(name: string): string {
  const value = name.replaceAll('\\', '/').split('/').filter(Boolean).join('/');
  return value || 'artifact';
}

function dosTimestamp(value: Date): { time: number; date: number } {
  const year = Math.max(value.getFullYear(), 1980);
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate()
  };
}

function updateCrc(crc: number, buffer: Buffer): number {
  let value = crc;
  for (const byte of buffer) {
    value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]!;
  }
  return value;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

import { assert, assertExists } from '@truckermudgeon/base/assert';
import { Preconditions, UnreachableError } from '@truckermudgeon/base/precon';
import fs from 'fs';
import { createRequire } from 'module';
import type { BaseOf } from 'restructure';
import * as r from 'restructure';
import zlib from 'zlib';
import { logger } from '../logger';
import { DdsHeader, DdsHeaderDX10 } from './dds-parser';
import {
  D3d10ResourceDimension,
  D3d10ResourceMiscFlag,
} from './enum-dds-format';
import { MappedNumber, uint64le } from './restructure-helpers';
import { ScsArchiveV1 } from './scs-archive-V1';
import { ZipArchive } from './zip-archive';

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-unsafe-call
export const { city64 } = require('bindings')('cityhash') as {
  city64: (s: string) => bigint;
};

// eslint-disable-next-line @typescript-eslint/no-unsafe-call
export const { gdeflate, deflate } = require('bindings')('gdeflate') as {
  gdeflate: (inBuffer: ArrayBuffer, outBuffer: ArrayBuffer) => number;
  deflate: (inBuffer: ArrayBuffer, outBuffer: ArrayBuffer) => number;
};

const Version = new r.Struct({
  magic: new r.String(4),
  version: r.int16le,
});

const FileHeaderV2 = new r.Struct({
  magic: new r.String(4),
  version: r.int16le,
  salt: r.int16le,
  hashMethod: new r.String(4),
  entryTableCount: r.uint32le,
  entryTableCompressedSize: r.uint32le,
  metadataTableSize: r.uint32le,
  metadataTableCompressedSize: r.uint32le,
  entryTableOffset: uint64le,
  metadataTableOffset: uint64le,
  securityDescriptorOffset: uint64le,
  hashfsV2Platform: r.uint8,
});

const EntryV2Header = new r.Struct({
  hash: uint64le,
  metadataIndex: r.uint32le,
  metadataCount: r.uint16le,
  flags: new r.Bitfield(r.uint8, ['isDirectory']),
  someByte: r.uint8,
});

export const enum MetadataType {
  IMG = 1,
  SAMPLE = 2,
  MIP_PROXY,
  INLINE_DIRECTORY = 4,
  PMA_INFO = 5,
  PMG_INFO = 6,
  PLAIN = 1 << 7,
  DIRECTORY = MetadataType.PLAIN | 1,
  MIP_0 = MetadataType.PLAIN | 2,
  MIP_1 = MetadataType.PLAIN | 3,
  MIP_TAIL = MetadataType.PLAIN | 4,
}

const enum Compression {
  NONE = 0,
  ZLIB = 1,
  ZLIB_HEADERLESS = 2,
  GDEFLATE = 3,
  ZSTD = 4,
}

const toCompression = (compression: number) => {
  switch (compression) {
    case 0:
      return Compression.NONE;
    case 1:
      return Compression.ZLIB;
    case 2:
      return Compression.ZLIB_HEADERLESS;
    case 3:
      return Compression.GDEFLATE;
    case 4:
      return Compression.ZSTD;
    default:
      throw new Error('unknown compression value: ' + compression);
  }
};

// MetadataEntryHeader::type === MetadataType.IMG
const ImageMeta = new r.Struct({
  width: new MappedNumber(r.uint16le, n => n + 1),
  height: new MappedNumber(r.uint16le, n => n + 1),
  image: new MappedNumber(r.uint32le, n => ({
    mipmapCount: 1 + (n & 0xf),
    format: (n >> 4) & 0xff,
    isCube: ((n >> 12) & 0b11) !== 0,
    count: ((n >> 14) & 0b11_1111) + 1,
    pitchAlignment: 1 << ((n >> 20) & 0b1111),
    imageAlignment: 1 << ((n >> 24) & 0b1111),
  })),
}); // 8 bytes

// MetadataEntryHeader::type === MetadataType.SAMPLE
const SampleMeta = new r.Struct({
  sample: new MappedNumber(r.uint32le, n => ({
    magFilter: n & 0b1, // 0 = nearest, 1 = linear
    minFilter: (n >> 1) & 0b1, // 0 = nearest, 1 = linear
    mipFilter: (n >> 2) & 0b11, // 0 = nearest, 1 = trilinear, 2 = nomips
    addr: {
      u: (n >> 4) & 0b111,
      v: (n >> 7) & 0b111,
      w: (n >> 10) & 0b111,
    },
  })),
}); // 4 bytes

// MetadataEntryHeader::type === MetadataType.PMA_INFO
const PmaInfoMeta = new r.Struct({
  flag: r.uint32le,
  animationLength: r.floatle,
  skeletonHash: uint64le,
  bSphereRad: r.floatle,
  bSphereOrgX: r.floatle,
  bSphereOrgY: r.floatle,
  bSphereOrgZ: r.floatle,
}); // 32 bytes

// MetadataEntryHeader::type === MetadataType.PMG_INFO
const PmgInfoMeta = new r.Struct({
  skeletonHash: uint64le,
}); // 8 bytes

// MetadataEntryHeader::type & MetadataType.PLAIN
const PlainMeta = new r.Struct({
  packedCompressionInfo: new MappedNumber(r.uint32le, n => ({
    compressedSize: n & 0x0f_ff_ff_ff,
    compression: toCompression((n & 0xf0_00_00_00) >> 28),
  })),
  size: new MappedNumber(r.uint32le, n => n & 0x0f_ff_ff_ff),
  _unknown: new r.Reserved(r.uint32le, 1),
  offset: new MappedNumber(r.uint32le, n => BigInt(n) * 16n),
}); // 16 bytes

type MetadataEntry = { version: MetadataType } & (
  | BaseOf<typeof ImageMeta>
  | BaseOf<typeof SampleMeta>
  | BaseOf<typeof PlainMeta>
  | BaseOf<typeof PmaInfoMeta>
  | BaseOf<typeof PmgInfoMeta>
);

const MetadataEntryHeader = new r.Struct({
  index: r.uint24le,
  type: r.uint8,
});

export interface Store<V> {
  get(key: string): V | undefined;
}

export interface Entries {
  directories: Store<DirectoryEntry>;
  files: Store<FileEntry>;
}

export function ScsArchive(path: string) {
  const fd = fs.openSync(path, 'r');

  const buffer = Buffer.alloc(Version.size());
  fs.readSync(fd, buffer, { length: buffer.length, position: 0 });
  const fileType = Version.fromBuffer(buffer);

  if (fileType.magic === 'SCS#' && fileType.version === 1) {
    return new ScsArchiveV1(fd, path);
  } else if (fileType.magic === 'SCS#' && fileType.version === 2) {
    return new ScsArchiveV2(fd, path);
  } else {
    return new ZipArchive(fd, path);
  }
}

export class ScsArchiveV2 {
  private readonly header;
  private entries: Entries | undefined;

  constructor(
    readonly fd: number,
    readonly path: string,
  ) {
    const buffer = Buffer.alloc(FileHeaderV2.size());
    fs.readSync(this.fd, buffer, { length: buffer.length });
    this.header = FileHeaderV2.fromBuffer(buffer);
  }

  dispose() {
    fs.closeSync(this.fd);
  }

  isValid(): boolean {
    return (
      this.header.magic === 'SCS#' &&
      this.header.hashMethod === 'CITY' &&
      this.header.version === 2
    );
  }

  parseEntries(): Entries {
    Preconditions.checkState(this.isValid());
    if (this.entries) {
      return this.entries;
    }

    const entryHeaders = new r.Array(
      EntryV2Header,
      this.header.entryTableCount,
    ).fromBuffer(
      this.readData({
        offset: this.header.entryTableOffset,
        compressedSize: this.header.entryTableCompressedSize,
        uncompressedSize: EntryV2Header.size() * this.header.entryTableCount,
      }),
    );
    const metadataMap = this.createMetadataMap(entryHeaders);

    const directories: DirectoryEntry[] = [];
    const files: FileEntry[] = [];
    for (const header of entryHeaders) {
      const entry = createEntryV2(this.fd, header, metadataMap);
      if (entry.type === 'directory') {
        directories.push(entry);
      } else {
        files.push(entry);
      }
    }
    this.entries = {
      directories: createStore(directories, this.header.salt),
      files: createStore(files, this.header.salt),
    };
    return this.entries;
  }

  private createMetadataMap(
    entryHeaders: BaseOf<typeof EntryV2Header>[],
  ): Map<number, MetadataEntry> {
    const metadataMap = new Map<number, MetadataEntry>();

    const metadataTable = this.readData({
      offset: this.header.metadataTableOffset,
      compressedSize: this.header.metadataTableCompressedSize,
      uncompressedSize: this.header.metadataTableSize,
    });
    const skippedMetaTypes = new Set();
    for (const header of entryHeaders) {
      for (let i = 0; i < header.metadataCount; i++) {
        const metadataHeaderByteOffset = 4 * (header.metadataIndex + i);
        const metadataHeader = MetadataEntryHeader.fromBuffer(
          metadataTable.subarray(
            metadataHeaderByteOffset,
            metadataHeaderByteOffset + MetadataEntryHeader.size(),
          ),
        );
        const type = metadataHeader.type as MetadataType;
        switch (type) {
          case MetadataType.IMG:
          case MetadataType.SAMPLE:
          case MetadataType.PLAIN:
          case MetadataType.DIRECTORY:
          case MetadataType.MIP_TAIL:
          case MetadataType.PMA_INFO:
          case MetadataType.PMG_INFO: {
            let descriptor;
            if (type === MetadataType.IMG) {
              descriptor = ImageMeta;
            } else if (type === MetadataType.SAMPLE) {
              descriptor = SampleMeta;
            } else if (type === MetadataType.PMA_INFO) {
              descriptor = PmaInfoMeta;
            } else if (type === MetadataType.PMG_INFO) {
              descriptor = PmgInfoMeta;
            } else {
              descriptor = PlainMeta;
            }
            const metadataEntryByteOffset = 4 * metadataHeader.index;
            metadataMap.set(header.metadataIndex + i, {
              version: metadataHeader.type,
              ...descriptor.fromBuffer(
                metadataTable.subarray(
                  metadataEntryByteOffset,
                  metadataEntryByteOffset + descriptor.size(),
                ),
              ),
            });
            break;
          }
          case MetadataType.MIP_0:
          case MetadataType.MIP_1:
          case MetadataType.MIP_PROXY:
          case MetadataType.INLINE_DIRECTORY:
            skippedMetaTypes.add(metadataHeader.type);
            break;
          default:
            throw new UnreachableError(type);
        }
      }
    }
    if (skippedMetaTypes.size) {
      logger.warn('skipped metadata types', skippedMetaTypes);
    }

    return metadataMap;
  }

  private readData({
    offset,
    compressedSize,
    uncompressedSize,
  }: {
    offset: bigint;
    compressedSize: number;
    uncompressedSize: number;
  }): Buffer {
    const buffer = Buffer.alloc(compressedSize);
    fs.readSync(this.fd, buffer, {
      length: buffer.length,
      position: offset,
    });
    return compressedSize !== uncompressedSize
      ? zlib.inflateSync(buffer)
      : buffer;
  }
}

export function createStore<V extends { hash: bigint }>(
  values: V[],
  salt: number,
) {
  const map = new Map(values.map(v => [v.hash, v]));
  return {
    get: (key: string) => map.get(city64(salt === 0 ? key : salt + key)),
  };
}

interface EntryV2Metadata {
  hash: bigint;
  offset: bigint;
  compressedSize: number;
  uncompressedSize: number;
  compression: Compression;
  isDirectory: boolean;
}

function createEntryV2(
  fd: number,
  header: BaseOf<typeof EntryV2Header>,
  metadataMap: Map<number, MetadataEntry>,
): DirectoryEntry | FileEntry {
  if (header.metadataCount === 3) {
    return createTobjEntry(fd, header, metadataMap);
  }

  // assert(header.metadataCount === 1);
  const assocMetadata = assertExists(metadataMap.get(header.metadataIndex));
  if (header.flags.isDirectory) {
    assert(
      assocMetadata.version === MetadataType.DIRECTORY,
      `assocMetadata.version ${assocMetadata.version} isn't DIRECTORY`,
    );
  }

  assert(
    assocMetadata.version === MetadataType.PLAIN ||
      assocMetadata.version === MetadataType.DIRECTORY,
  );
  const plainMeta = assocMetadata as BaseOf<typeof PlainMeta>;
  const metadata = {
    hash: header.hash,
    offset: plainMeta.offset,
    compressedSize: plainMeta.packedCompressionInfo.compressedSize,
    uncompressedSize: plainMeta.size,
    compression: plainMeta.packedCompressionInfo.compression,
    isDirectory: header.flags.isDirectory,
  };

  return metadata.isDirectory
    ? new ScsArchiveDirectoryV2(fd, metadata)
    : new ScsArchiveFileV2(fd, metadata);
}

function createTobjEntry(
  fd: number,
  header: BaseOf<typeof EntryV2Header>,
  metadataMap: Map<number, MetadataEntry>,
): FileEntry {
  Preconditions.checkArgument(
    !header.flags.isDirectory && header.metadataCount === 3,
  );
  const metas = [
    assertExists(metadataMap.get(header.metadataIndex)),
    assertExists(metadataMap.get(header.metadataIndex + 1)),
    assertExists(metadataMap.get(header.metadataIndex + 2)),
  ];
  const imageMeta = assertExists(
    metas.find(m => m.version === MetadataType.IMG),
  ) as BaseOf<typeof ImageMeta>;
  // SampleMeta isn't used by `parser`, but check for it anyway Just In Case™
  assertExists(metas.find(m => m.version === MetadataType.SAMPLE)) as BaseOf<
    typeof SampleMeta
  >;
  const plainMeta = assertExists(
    metas.find(m => m.version === MetadataType.MIP_TAIL),
  ) as BaseOf<typeof PlainMeta>;

  return new ScsArchiveTobjFile(
    fd,
    {
      hash: header.hash,
      offset: plainMeta.offset,
      compressedSize: plainMeta.packedCompressionInfo.compressedSize,
      uncompressedSize: plainMeta.size,
      compression: plainMeta.packedCompressionInfo.compression,
      isDirectory: header.flags.isDirectory,
    },
    imageMeta,
  );
}

export interface FileEntry {
  readonly type: 'file';
  readonly hash: bigint;

  read(): Buffer;
}

export interface DirectoryEntry {
  readonly type: 'directory';
  readonly hash: bigint;
  readonly subdirectories: readonly string[];
  readonly files: readonly string[];
}

export const TileStreamHeader = new r.Struct({
  id: r.uint8,
  magic: r.uint8,
  numTiles: r.uint16le,
  tileSizeIdx: r.uint32le,
  lastTileSize: r.uint32le,
});

abstract class ScsArchiveEntryV2 {
  abstract type: string;

  protected constructor(
    protected readonly fd: number,
    protected readonly metadata: EntryV2Metadata,
  ) {}

  get hash(): bigint {
    return this.metadata.hash;
  }

  read() {
    const rawData = Buffer.alloc(this.metadata.compressedSize);
    const bytesRead = fs.readSync(this.fd, rawData, {
      length: rawData.length,
      position: this.metadata.offset,
    });
    assert(bytesRead === rawData.length);
    switch (this.metadata.compression) {
      case Compression.NONE:
        return rawData;
      case Compression.ZLIB:
        return zlib.inflateSync(rawData);
      case Compression.GDEFLATE: {
        const tileStreamHeader = TileStreamHeader.decode(
          new r.DecodeStream(rawData),
        );
        const tileOffsets = new Uint32Array(
          rawData.buffer,
          TileStreamHeader.size(),
          tileStreamHeader.numTiles - 1,
        );
        const tilesData = rawData.buffer.slice(
          TileStreamHeader.size() + tileOffsets.byteLength,
        );

        const kDefaultTileSize = 64 * 1024;
        const outputBuffer = Buffer.alloc(this.metadata.uncompressedSize);
        for (
          let tileIndex = 0, outputOffset = 0;
          tileIndex < tileStreamHeader.numTiles;
          tileIndex++, outputOffset += kDefaultTileSize
        ) {
          const tileData = tilesData.slice(
            tileIndex === 0 ? 0 : tileOffsets[tileIndex - 1],
          );
          const outputTileBuffer = Buffer.alloc(kDefaultTileSize);
          const result = gdeflate(tileData, outputTileBuffer.buffer);
          if (result !== 0) {
            throw new Error(`gdeflate error: ${result}`);
          }
          outputTileBuffer.copy(outputBuffer, outputOffset);
        }
        return outputBuffer;
      }
      case Compression.ZLIB_HEADERLESS:
      case Compression.ZSTD:
      default:
        throw new Error(
          `unsupported compression type ${this.metadata.compression}`,
        );
    }
  }
}

export class ScsArchiveFileV2 extends ScsArchiveEntryV2 implements FileEntry {
  readonly type = 'file';

  constructor(fd: number, metadata: EntryV2Metadata) {
    super(fd, metadata);
  }
}

class ScsArchiveTobjFile extends ScsArchiveFileV2 {
  constructor(
    fd: number,
    metadata: EntryV2Metadata,
    private readonly imageMetadata: BaseOf<typeof ImageMeta>,
  ) {
    super(fd, metadata);
  }

  override read() {
    const imageMeta = this.imageMetadata.image;

    const ddsBytes = super.read();
    const { width, height } = this.imageMetadata;

    // Values here are the bare minimum to get DDS via parseDds to work.
    const header = Buffer.from(
      DdsHeader.toBuffer({
        size: DdsHeader.size(),
        flags: 0,
        height,
        width,
        pitchOrLinearSize: ddsBytes.length,
        depth: 0,
        mipMapCount: imageMeta.mipmapCount,
        reserved1: undefined,
        ddsPixelFormat: {
          size: 32,
          flags: 0x4,
          // this looks like the only field of import.
          fourCc: 'DX10',
          rgbBitCount: 0,
          rBitMask: 0,
          gBitMask: 0,
          bBitMask: 0,
          aBitMask: 0,
        },
        caps: 0,
        caps2: 0,
        caps3: 0,
        caps4: 0,
        reserved2: undefined,
      }),
    );

    const headerDX10 = Buffer.from(
      DdsHeaderDX10.toBuffer({
        dxgiFormat: this.imageMetadata.image.format,
        resourceDimension: D3d10ResourceDimension.Texture2d,
        miscFlag: this.imageMetadata.image.isCube
          ? D3d10ResourceMiscFlag.TextureCube
          : 0,
        arraySize: 1,
        miscFlags2: 0,
      }),
    );

    const ddsFile = Buffer.alloc(
      4 + // magic
        DdsHeader.size() +
        DdsHeaderDX10.size() +
        ddsBytes.length,
    );

    ddsFile.write('DDS ');
    header.copy(ddsFile, 4);
    headerDX10.copy(ddsFile, 128);
    ddsBytes.copy(ddsFile, 4 + DdsHeader.size() + DdsHeaderDX10.size());

    return ddsFile;
  }
}

class ScsArchiveDirectoryV2
  extends ScsArchiveEntryV2
  implements DirectoryEntry
{
  readonly type = 'directory';
  readonly subdirectories: readonly string[];
  readonly files: readonly string[];

  constructor(fd: number, metadata: EntryV2Metadata) {
    super(fd, metadata);

    const reader = new r.DecodeStream(this.read());
    const numStrings = reader.readBuffer(4).readUInt32LE();
    const stringLengths = reader.readBuffer(numStrings).values();

    const subdirectories: string[] = [];
    const files: string[] = [];
    for (const stringLength of stringLengths) {
      const str = reader.readBuffer(stringLength).toString();
      if (str.startsWith('/')) {
        subdirectories.push(str.substring(1));
      } else {
        files.push(str);
      }
    }
    this.subdirectories = subdirectories;
    this.files = files;
  }
}

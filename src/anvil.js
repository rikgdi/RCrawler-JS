const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const {
  DIMENSION_SECTION_COUNTS,
  PROTOCOL_VERSION,
  loadProtocolSpec,
} = require("./packets");
const {
  ByteReader,
  ProtocolError,
  calculateRequiredLongs,
  readNbtRoot,
  TAG_END,
  TAG_BYTE,
  TAG_SHORT,
  TAG_INT,
  TAG_LONG,
  TAG_FLOAT,
  TAG_DOUBLE,
  TAG_BYTE_ARRAY,
  TAG_STRING,
  TAG_LIST,
  TAG_COMPOUND,
  TAG_INT_ARRAY,
  TAG_LONG_ARRAY,
} = require("./protocol");

const CHUNK_FILE_MAGIC = Buffer.from("MCCAP001", "ascii");

const HEIGHTMAP_NAMES = {
  0: "WORLD_SURFACE_WG",
  1: "WORLD_SURFACE",
  2: "OCEAN_FLOOR_WG",
  3: "OCEAN_FLOOR",
  4: "MOTION_BLOCKING",
  5: "MOTION_BLOCKING_NO_LEAVES",
};

const DIMENSION_MIN_SECTION_Y = {
  "minecraft:overworld": -4,
  "minecraft:the_nether": 0,
  "minecraft:the_end": 0,
};

class ConversionError extends ProtocolError {}

class NBTTag {
  constructor(tagId, value) {
    this.tagId = tagId;
    this.value = value;
  }
}

function nbtByte(value) {
  return new NBTTag(TAG_BYTE, value);
}

function nbtShort(value) {
  return new NBTTag(TAG_SHORT, value);
}

function nbtInt(value) {
  return new NBTTag(TAG_INT, value);
}

function nbtLong(value) {
  return new NBTTag(TAG_LONG, BigInt(value));
}

function nbtDouble(value) {
  return new NBTTag(TAG_DOUBLE, value);
}

function nbtString(value) {
  return new NBTTag(TAG_STRING, String(value));
}

function nbtByteArray(value) {
  return new NBTTag(TAG_BYTE_ARRAY, Buffer.from(value));
}

function nbtLongArray(values) {
  return new NBTTag(TAG_LONG_ARRAY, values.map((item) => BigInt(item)));
}

function nbtList(items, { elementTag = null } = {}) {
  return new NBTTag(TAG_LIST, {
    elementTag: elementTag == null ? (items[0] ? items[0].tagId : TAG_END) : elementTag,
    items,
  });
}

function nbtCompound(values) {
  return new NBTTag(TAG_COMPOUND, values);
}

function encodeNbtString(value) {
  const encoded = Buffer.from(String(value), "utf8");
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(encoded.length, 0);
  return Buffer.concat([prefix, encoded]);
}

function encodePayloadById(tagId, value) {
  if (tagId === TAG_BYTE) {
    const buffer = Buffer.alloc(1);
    buffer.writeInt8(Number(value), 0);
    return buffer;
  }
  if (tagId === TAG_SHORT) {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16BE(Number(value), 0);
    return buffer;
  }
  if (tagId === TAG_INT) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(Number(value), 0);
    return buffer;
  }
  if (tagId === TAG_LONG) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(toSignedLong(value), 0);
    return buffer;
  }
  if (tagId === TAG_FLOAT) {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatBE(Number(value), 0);
    return buffer;
  }
  if (tagId === TAG_DOUBLE) {
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleBE(Number(value), 0);
    return buffer;
  }
  if (tagId === TAG_BYTE_ARRAY) {
    const raw = Buffer.from(value);
    const prefix = Buffer.alloc(4);
    prefix.writeInt32BE(raw.length, 0);
    return Buffer.concat([prefix, raw]);
  }
  if (tagId === TAG_STRING) {
    return encodeNbtString(value);
  }
  if (tagId === TAG_LIST) {
    const { elementTag, items } = value;
    const header = Buffer.alloc(5);
    header.writeUInt8(Number(elementTag), 0);
    header.writeInt32BE(items.length, 1);
    const parts = [header];
    for (const item of items) {
      if (!(item instanceof NBTTag)) {
        throw new ConversionError("NBT list items must be NBTTag instances");
      }
      parts.push(encodePayloadById(item.tagId, item.value));
    }
    return Buffer.concat(parts);
  }
  if (tagId === TAG_COMPOUND) {
    const parts = [];
    for (const [name, child] of Object.entries(value)) {
      if (!(child instanceof NBTTag)) {
        throw new ConversionError("NBT compound values must be NBTTag instances");
      }
      parts.push(Buffer.from([child.tagId]));
      parts.push(encodeNbtString(name));
      parts.push(encodePayloadById(child.tagId, child.value));
    }
    parts.push(Buffer.from([TAG_END]));
    return Buffer.concat(parts);
  }
  if (tagId === TAG_INT_ARRAY) {
    const values = Array.from(value);
    const parts = [Buffer.alloc(4)];
    parts[0].writeInt32BE(values.length, 0);
    for (const item of values) {
      const buffer = Buffer.alloc(4);
      buffer.writeInt32BE(Number(item), 0);
      parts.push(buffer);
    }
    return Buffer.concat(parts);
  }
  if (tagId === TAG_LONG_ARRAY) {
    const values = Array.from(value);
    const parts = [Buffer.alloc(4)];
    parts[0].writeInt32BE(values.length, 0);
    for (const item of values) {
      const buffer = Buffer.alloc(8);
      buffer.writeBigInt64BE(toSignedLong(item), 0);
      parts.push(buffer);
    }
    return Buffer.concat(parts);
  }
  throw new ConversionError(`Unsupported NBT tag id ${tagId}`);
}

function encodeNbtRoot(root, rootName = "") {
  return Buffer.concat([
    Buffer.from([TAG_COMPOUND]),
    encodeNbtString(rootName),
    encodePayloadById(TAG_COMPOUND, root),
  ]);
}

function toSignedLong(value) {
  return BigInt.asIntN(64, BigInt(value));
}

function requiredBits(paletteSize, { minimum }) {
  let bits = minimum;
  while ((1 << bits) < Math.max(1, paletteSize)) {
    bits += 1;
  }
  return bits;
}

function unpackIndices(longs, bitsPerEntry, entryCount) {
  if (bitsPerEntry <= 0) {
    return Array(entryCount).fill(0);
  }

  const mask = (1n << BigInt(bitsPerEntry)) - 1n;
  const longValues = longs.map((value) => BigInt.asUintN(64, BigInt(value)));
  const indices = [];
  let bitOffset = 0;
  let longIndex = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (bitOffset + bitsPerEntry > 64) {
      bitOffset = 0;
      longIndex += 1;
    }
    indices.push(Number((longValues[longIndex] >> BigInt(bitOffset)) & mask));
    bitOffset += bitsPerEntry;
  }

  return indices;
}

function packIndices(indices, bitsPerEntry) {
  if (bitsPerEntry <= 0 || indices.length === 0) {
    return [];
  }

  const longCount = calculateRequiredLongs(indices.length, bitsPerEntry);
  const packed = Array(longCount).fill(0n);
  let bitOffset = 0;
  let longIndex = 0;

  for (const index of indices) {
    if (bitOffset + bitsPerEntry > 64) {
      bitOffset = 0;
      longIndex += 1;
    }
    packed[longIndex] |= BigInt(index) << BigInt(bitOffset);
    bitOffset += bitsPerEntry;
  }

  return packed.map((value) => toSignedLong(value));
}

class BlockStateRegistry {
  constructor(blocksJsonPath) {
    this.blocksJsonPath = path.resolve(blocksJsonPath);
    this.cache = null;
  }

  load() {
    if (this.cache) {
      return this.cache;
    }

    const raw = JSON.parse(fs.readFileSync(this.blocksJsonPath, "utf8"));
    const cache = new Map();
    for (const [blockName, blockData] of Object.entries(raw)) {
      for (const state of blockData.states || []) {
        const entry = { Name: blockName };
        const properties = state.properties || {};
        if (Object.keys(properties).length > 0) {
          entry.Properties = Object.fromEntries(
            Object.entries(properties).map(([key, value]) => [key, String(value)]),
          );
        }
        cache.set(Number(state.id), entry);
      }
    }

    this.cache = cache;
    return cache;
  }
}

class CapturedChunk {
  constructor({ path: chunkPath, metadata, packetPayload, rawChunkData }) {
    this.path = chunkPath;
    this.metadata = metadata;
    this.packetPayload = packetPayload;
    this.rawChunkData = rawChunkData;
  }

  static load(chunkPath) {
    const resolved = path.resolve(chunkPath);
    const data = fs.readFileSync(resolved);
    if (!data.subarray(0, 8).equals(CHUNK_FILE_MAGIC)) {
      throw new ConversionError(`${resolved} does not start with the expected chunk magic header`);
    }

    const headerLength = data.readUInt32BE(8);
    const payloadLength = data.readUInt32BE(12);
    const chunkDataLength = data.readUInt32BE(16);
    let cursor = 20;
    const header = JSON.parse(data.subarray(cursor, cursor + headerLength).toString("utf8"));
    cursor += headerLength;
    const packetPayload = data.subarray(cursor, cursor + payloadLength);
    cursor += payloadLength;
    const rawChunkData = data.subarray(cursor, cursor + chunkDataLength);

    return new CapturedChunk({
      path: resolved,
      metadata: header,
      packetPayload,
      rawChunkData,
    });
  }
}

class ProtocolContainer {
  constructor({ mode, bitsPerEntry, paletteIds, dataLongs, singleValue }) {
    this.mode = mode;
    this.bitsPerEntry = bitsPerEntry;
    this.paletteIds = paletteIds;
    this.dataLongs = dataLongs;
    this.singleValue = singleValue;
  }
}

class ChunkNBTBuilder {
  constructor({ blocksJsonPath, defaultBiome = "minecraft:plains", logger = console }) {
    this.logger = logger;
    this.defaultBiome = defaultBiome;
    this.blockStates = new BlockStateRegistry(blocksJsonPath).load();
  }

  convertCapture(capture) {
    const metadata = capture.metadata;
    const chunkX = Number(metadata.chunk_x);
    const chunkZ = Number(metadata.chunk_z);
    const protocolVersion = Number(metadata.protocol_version || PROTOCOL_VERSION);
    const protocolSpec = loadProtocolSpec(protocolVersion);
    const dimension = String(metadata.dimension || "minecraft:overworld");
    const sectionCount = Number(
      metadata.expected_section_count || DIMENSION_SECTION_COUNTS[dimension] || 24,
    );
    const minSectionY = DIMENSION_MIN_SECTION_Y[dimension] ?? -4;
    const dataVersion = Number(metadata.data_version || protocolSpec.dataVersion);

    const packetReader = new ByteReader(capture.packetPayload);
    packetReader.readInt();
    packetReader.readInt();
    const heightmaps = this._readHeightmaps(
      packetReader,
      protocolSpec.features.levelChunkHeightmapsFormat,
    );
    const chunkDataLength = packetReader.readVarInt();
    const rawChunkData = packetReader.read(chunkDataLength);

    const sections = this._buildSections(
      rawChunkData,
      sectionCount,
      minSectionY,
      protocolSpec.features.palettedContainerHasDataArrayLength,
      protocolSpec.features.chunkSectionHasFluidCount,
    );
    const root = this._buildRootChunk({
      chunkX,
      chunkZ,
      sectionCount,
      minSectionY,
      sections,
      heightmaps,
      dataVersion,
    });
    return [chunkX, chunkZ, encodeNbtRoot(root)];
  }

  _readHeightmaps(reader, heightmapsFormat) {
    if (heightmapsFormat === "varint") {
      const count = reader.readVarInt();
      const heightmaps = {};
      for (let index = 0; index < count; index += 1) {
        const typeId = reader.readVarInt();
        const arrayLength = reader.readVarInt();
        const values = Array.from({ length: arrayLength }, () => toSignedLong(reader.readUnsignedLong()));
        const name = HEIGHTMAP_NAMES[typeId];
        if (name != null) {
          heightmaps[name] = values;
        } else {
          this.logger.debug("Skipping unknown heightmap type id %s", typeId);
        }
      }
      return heightmaps;
    }

    const [, root] = readNbtRoot(reader);
    if (root.tagId !== TAG_COMPOUND) {
      throw new ConversionError(`Expected compound heightmaps root, got tag id ${root.tagId}`);
    }

    const heightmaps = {};
    for (const [name, value] of Object.entries(root.value)) {
      if (value.tagId !== TAG_LONG_ARRAY) {
        continue;
      }
      heightmaps[name] = value.value.map((item) => BigInt(item));
    }
    return heightmaps;
  }

  _buildSections(rawChunkData, sectionCount, minSectionY, hasDataArrayLength, hasFluidCount = false) {
    const reader = new ByteReader(rawChunkData);
    const sections = [];

    for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
      if (reader.remaining <= 0) {
        break;
      }

      reader.readShort();
      if (hasFluidCount) {
        reader.readShort();
      }
      const blockContainer = this._readProtocolContainer(reader, 4096, "blocks", hasDataArrayLength);
      this._readProtocolContainer(reader, 64, "biomes", hasDataArrayLength);
      const sectionY = minSectionY + sectionIndex;
      sections.push(this._sectionToNbt(sectionY, blockContainer));
    }

    while (sections.length < sectionCount) {
      const sectionY = minSectionY + sections.length;
      sections.push(this._emptySection(sectionY));
    }

    if (reader.remaining !== 0) {
      this.logger.debug("Chunk data had %s trailing bytes after section parsing", reader.remaining);
    }

    return sections;
  }

  _readProtocolContainer(reader, entryCount, kind, hasDataArrayLength) {
    const bitsPerEntry = reader.readUnsignedByte();
    if (bitsPerEntry === 0) {
      const singleValue = reader.readVarInt();
      if (hasDataArrayLength) {
        const dataLength = reader.readVarInt();
        if (dataLength !== 0) {
          throw new ConversionError(
            `Unexpected ${kind} data array length ${dataLength} for single-valued container`,
          );
        }
      }
      return new ProtocolContainer({
        mode: "single",
        bitsPerEntry: 0,
        paletteIds: [],
        dataLongs: [],
        singleValue,
      });
    }

    const indirect = kind === "blocks"
      ? bitsPerEntry >= 4 && bitsPerEntry <= 8
      : bitsPerEntry >= 1 && bitsPerEntry <= 3;

    let mode = "direct";
    let paletteIds = [];
    if (indirect) {
      mode = "indirect";
      const paletteLength = reader.readVarInt();
      paletteIds = Array.from({ length: paletteLength }, () => reader.readVarInt());
    }

    const expectedLength = calculateRequiredLongs(entryCount, bitsPerEntry);
    let dataLength = expectedLength;
    if (hasDataArrayLength) {
      dataLength = reader.readVarInt();
      if (dataLength !== expectedLength) {
        throw new ConversionError(
          `Unexpected ${kind} data array length ${dataLength}; expected ${expectedLength} for ${entryCount} entries at ${bitsPerEntry} bits`,
        );
      }
    }

    const dataLongs = Array.from({ length: dataLength }, () => reader.readLong());
    return new ProtocolContainer({
      mode,
      bitsPerEntry,
      paletteIds,
      dataLongs,
      singleValue: null,
    });
  }

  _sectionToNbt(sectionY, blockContainer) {
    let paletteEntries;
    let blockStatesValue;

    if (blockContainer.mode === "single") {
      const blockStateId = Number(blockContainer.singleValue || 0);
      paletteEntries = [this._blockPaletteEntry(blockStateId)];
      blockStatesValue = {
        palette: nbtList(paletteEntries.map((entry) => nbtCompound(entry)), { elementTag: TAG_COMPOUND }),
      };
    } else if (blockContainer.mode === "indirect") {
      paletteEntries = blockContainer.paletteIds.map((blockStateId) => this._blockPaletteEntry(blockStateId));
      const decodedIndices = unpackIndices(blockContainer.dataLongs, blockContainer.bitsPerEntry, 4096);
      blockStatesValue = {
        palette: nbtList(paletteEntries.map((entry) => nbtCompound(entry)), { elementTag: TAG_COMPOUND }),
      };
      if (paletteEntries.length > 1) {
        const required = requiredBits(paletteEntries.length, { minimum: 4 });
        blockStatesValue.data = nbtLongArray(packIndices(decodedIndices, required));
      }
    } else {
      const globalStateIds = unpackIndices(blockContainer.dataLongs, blockContainer.bitsPerEntry, 4096);
      const [localPaletteEntries, indices] = this._buildLocalPalette(globalStateIds);
      paletteEntries = localPaletteEntries;
      blockStatesValue = {
        palette: nbtList(paletteEntries.map((entry) => nbtCompound(entry)), { elementTag: TAG_COMPOUND }),
      };
      if (paletteEntries.length > 1) {
        const required = requiredBits(paletteEntries.length, { minimum: 4 });
        blockStatesValue.data = nbtLongArray(packIndices(indices, required));
      }
    }

    return nbtCompound({
      Y: nbtByte(sectionY),
      block_states: nbtCompound(blockStatesValue),
      biomes: nbtCompound({
        palette: nbtList([nbtString(this.defaultBiome)], { elementTag: TAG_STRING }),
      }),
    });
  }

  _emptySection(sectionY) {
    return this._sectionToNbt(
      sectionY,
      new ProtocolContainer({
        mode: "single",
        bitsPerEntry: 0,
        paletteIds: [],
        dataLongs: [],
        singleValue: 0,
      }),
    );
  }

  _blockPaletteEntry(stateId) {
    const state = this.blockStates.get(Number(stateId));
    if (!state) {
      throw new ConversionError(`Unknown block state id ${stateId}`);
    }

    const entry = { Name: nbtString(state.Name) };
    if (state.Properties) {
      entry.Properties = nbtCompound(
        Object.fromEntries(
          Object.entries(state.Properties).map(([key, value]) => [key, nbtString(value)]),
        ),
      );
    }
    return entry;
  }

  _buildLocalPalette(stateIds) {
    const paletteEntries = [];
    const paletteLookup = new Map();
    const indices = [];

    for (const stateId of stateIds) {
      if (!paletteLookup.has(stateId)) {
        paletteLookup.set(stateId, paletteEntries.length);
        paletteEntries.push(this._blockPaletteEntry(stateId));
      }
      indices.push(paletteLookup.get(stateId));
    }

    return [paletteEntries, indices];
  }

  _buildRootChunk({ chunkX, chunkZ, sectionCount, minSectionY, sections, heightmaps, dataVersion }) {
    const postProcessing = Array.from(
      { length: sectionCount },
      () => nbtList([], { elementTag: TAG_END }),
    );

    const finalHeightmaps = Object.keys(heightmaps).length > 0 ? heightmaps : {
      WORLD_SURFACE: Array(37).fill(0n),
      MOTION_BLOCKING: Array(37).fill(0n),
      MOTION_BLOCKING_NO_LEAVES: Array(37).fill(0n),
    };

    return {
      DataVersion: nbtInt(dataVersion),
      Status: nbtString("minecraft:full"),
      xPos: nbtInt(chunkX),
      yPos: nbtInt(minSectionY),
      zPos: nbtInt(chunkZ),
      LastUpdate: nbtLong(0n),
      InhabitedTime: nbtLong(0n),
      isLightOn: nbtByte(0),
      sections: nbtList(sections, { elementTag: TAG_COMPOUND }),
      block_entities: nbtList([], { elementTag: TAG_END }),
      block_ticks: nbtList([], { elementTag: TAG_END }),
      fluid_ticks: nbtList([], { elementTag: TAG_END }),
      PostProcessing: nbtList(postProcessing, { elementTag: TAG_LIST }),
      Heightmaps: nbtCompound(
        Object.fromEntries(
          Object.entries(finalHeightmaps).map(([name, values]) => [name, nbtLongArray(values)]),
        ),
      ),
      structures: nbtCompound({
        References: nbtCompound({}),
        starts: nbtCompound({}),
      }),
    };
  }
}

class RegionWriter {
  constructor({ logger = console } = {}) {
    this.logger = logger;
  }

  writeRegion(regionPath, chunks) {
    const locationTable = Buffer.alloc(4096);
    const timestampTable = Buffer.alloc(4096);
    const bodyParts = [];
    let bodyLength = 0;
    let sectorOffset = 2;
    const timestamp = Math.floor(Date.now() / 1000);

    const sortedChunks = [...chunks].sort((a, b) => {
      if (a.localZ !== b.localZ) {
        return a.localZ - b.localZ;
      }
      return a.localX - b.localX;
    });

    for (const { localX, localZ, nbtPayload } of sortedChunks) {
      const compressed = zlib.deflateSync(nbtPayload);
      const recordHeader = Buffer.alloc(5);
      recordHeader.writeUInt32BE(compressed.length + 1, 0);
      recordHeader.writeUInt8(2, 4);
      const chunkRecord = Buffer.concat([recordHeader, compressed]);
      const padding = (4096 - (chunkRecord.length % 4096)) % 4096;
      const sectorCount = (chunkRecord.length + padding) / 4096;

      const index = localX + (localZ * 32);
      locationTable.writeUIntBE(sectorOffset, index * 4, 3);
      locationTable.writeUInt8(sectorCount, (index * 4) + 3);
      timestampTable.writeUInt32BE(timestamp, index * 4);

      bodyParts.push(chunkRecord);
      bodyLength += chunkRecord.length;
      if (padding > 0) {
        const paddingBuffer = Buffer.alloc(padding);
        bodyParts.push(paddingBuffer);
        bodyLength += paddingBuffer.length;
      }

      sectorOffset += sectorCount;
    }

    fs.mkdirSync(path.dirname(regionPath), { recursive: true });
    fs.writeFileSync(
      regionPath,
      Buffer.concat([locationTable, timestampTable, ...bodyParts], 8192 + bodyLength),
    );
    this.logger.info("Wrote region file %s with %s chunk(s)", regionPath, chunks.length);
  }
}

class WorldExporter {
  constructor({
    chunksDir,
    worldDir,
    blocksJsonPath = null,
    defaultBiome = "minecraft:plains",
    logger = console,
  }) {
    this.chunksDir = path.resolve(chunksDir);
    this.worldDir = path.resolve(worldDir);
    this.regionDir = path.join(this.worldDir, "region");
    this.blocksJsonPath = blocksJsonPath ? path.resolve(blocksJsonPath) : null;
    this.defaultBiome = defaultBiome;
    this.logger = logger;
    this.builders = new Map();
    this.regionWriter = new RegionWriter({ logger: this.logger });
  }

  _builderForCapture(capture) {
    const blocksJsonPath = this.blocksJsonPath
      || loadProtocolSpec(Number(capture.metadata.protocol_version || PROTOCOL_VERSION)).blocksJsonPath;

    if (!fs.existsSync(blocksJsonPath)) {
      throw new ConversionError(
        `Missing block registry at ${blocksJsonPath}. Generate assets for this protocol or pass --blocks-json.`,
      );
    }

    if (!this.builders.has(blocksJsonPath)) {
      this.builders.set(
        blocksJsonPath,
        new ChunkNBTBuilder({
          blocksJsonPath,
          defaultBiome: this.defaultBiome,
          logger: this.logger,
        }),
      );
    }

    return this.builders.get(blocksJsonPath);
  }

  export() {
    fs.mkdirSync(this.regionDir, { recursive: true });
    const chunkFiles = fs.existsSync(this.chunksDir)
      ? fs.readdirSync(this.chunksDir)
        .filter((name) => /^chunk_.*\.bin$/.test(name))
        .sort()
      : [];

    if (chunkFiles.length === 0) {
      throw new ConversionError(`No chunk capture files were found in ${this.chunksDir}`);
    }

    const grouped = new Map();
    for (const chunkFile of chunkFiles) {
      const capture = CapturedChunk.load(path.join(this.chunksDir, chunkFile));
      const builder = this._builderForCapture(capture);
      const [chunkX, chunkZ, nbtPayload] = builder.convertCapture(capture);
      const regionX = Math.floor(chunkX / 32);
      const regionZ = Math.floor(chunkZ / 32);
      const localX = ((chunkX % 32) + 32) % 32;
      const localZ = ((chunkZ % 32) + 32) % 32;
      const regionKey = `${regionX},${regionZ}`;

      if (!grouped.has(regionKey)) {
        grouped.set(regionKey, {
          regionX,
          regionZ,
          chunks: [],
        });
      }
      grouped.get(regionKey).chunks.push({ localX, localZ, nbtPayload });
      this.logger.info("Converted %s -> region (%s, %s)", chunkFile, regionX, regionZ);
    }

    const writtenRegions = [];
    for (const { regionX, regionZ, chunks } of [...grouped.values()].sort((a, b) => {
      if (a.regionX !== b.regionX) {
        return a.regionX - b.regionX;
      }
      return a.regionZ - b.regionZ;
    })) {
      const regionPath = path.join(this.regionDir, `r.${regionX}.${regionZ}.mca`);
      this.regionWriter.writeRegion(regionPath, chunks);
      writtenRegions.push(regionPath);
    }

    return writtenRegions;
  }
}

module.exports = {
  CHUNK_FILE_MAGIC,
  HEIGHTMAP_NAMES,
  DIMENSION_MIN_SECTION_Y,
  ConversionError,
  NBTTag,
  nbtByte,
  nbtShort,
  nbtInt,
  nbtLong,
  nbtDouble,
  nbtString,
  nbtByteArray,
  nbtLongArray,
  nbtList,
  nbtCompound,
  encodeNbtRoot,
  toSignedLong,
  requiredBits,
  unpackIndices,
  packIndices,
  BlockStateRegistry,
  CapturedChunk,
  ProtocolContainer,
  ChunkNBTBuilder,
  RegionWriter,
  WorldExporter,
};

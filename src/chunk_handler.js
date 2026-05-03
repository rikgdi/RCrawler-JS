const fs = require("fs");
const path = require("path");

const {
  PROTOCOL_VERSION,
  loadProtocolSpec,
} = require("./packets");
const {
  ByteReader,
  ProtocolError,
  calculateRequiredLongs,
  readNbtRoot,
  skipNbtPayload,
} = require("./protocol");

const CHUNK_FILE_MAGIC = Buffer.from("MCCAP001", "ascii");

function stringifyJson(value, pretty = false) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    pretty ? 2 : undefined,
  );
}

class ChunkHandler {
  constructor({
    outputRoot = "output",
    worldRoot = "world",
    protocol = null,
    logger = null,
  } = {}) {
    this.outputRoot = path.resolve(outputRoot);
    this.worldRoot = path.resolve(worldRoot);
    this.chunkDir = path.join(this.outputRoot, "chunks");
    this.regionDir = path.join(this.worldRoot, "region");
    this.manifestPath = path.join(this.regionDir, "chunk_index.json");
    this.protocol = protocol || loadProtocolSpec(PROTOCOL_VERSION);
    this.logger = logger || console;
    this._prepareStorage();
  }

  saveChunkPacket(packetPayload, { dimensionName, expectedSectionCount }) {
    const now = new Date();
    const packetReader = new ByteReader(packetPayload);
    const chunkX = packetReader.readInt();
    const chunkZ = packetReader.readInt();

    const metadata = {
      format: "minecraft_chunk_capture/v1",
      minecraft_version: this.protocol.minecraftVersion,
      protocol_version: this.protocol.protocolVersion,
      data_version: this.protocol.dataVersion,
      chunk_x: chunkX,
      chunk_z: chunkZ,
      dimension: dimensionName,
      expected_section_count: expectedSectionCount,
      timestamp_unix_ms: now.getTime(),
      timestamp_utc: now.toISOString(),
      raw_packet_payload_length: packetPayload.length,
    };

    metadata.heightmaps = this._readHeightmaps(packetReader);
    const rawChunkDataLength = packetReader.readVarInt();
    const rawChunkData = Buffer.from(packetReader.read(rawChunkDataLength));
    metadata.raw_chunk_data_length = rawChunkData.length;

    try {
      const [sections, leftover] = this._splitChunkData(rawChunkData, expectedSectionCount);
      metadata.sections = sections;
      metadata.chunk_data_leftover_bytes = leftover;
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        throw error;
      }
      metadata.sections = [];
      metadata.chunk_data_leftover_bytes = rawChunkData.length;
      metadata.chunk_data_parse_error = error.message;
      this.logger.warning(
        "Chunk section parsing fell back to raw storage for (%s, %s): %s",
        chunkX,
        chunkZ,
        error.message,
      );
    }

    try {
      const [blockEntities, lightUpdate, trailingBytes] = this._parseTrailingPayload(packetReader);
      metadata.block_entities = blockEntities;
      metadata.light_update = lightUpdate;
      metadata.trailing_bytes_after_parse = trailingBytes;
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        throw error;
      }
      metadata.block_entities = [];
      metadata.light_update = {};
      metadata.trailing_parse_error = error.message;
      metadata.trailing_bytes_after_parse = packetReader.remaining;
      this.logger.warning(
        "Chunk trailing payload parsing failed for (%s, %s): %s",
        chunkX,
        chunkZ,
        error.message,
      );
    }

    const chunkPath = path.join(this.chunkDir, `chunk_${chunkX}_${chunkZ}.bin`);
    this._writeChunkFile(chunkPath, metadata, packetPayload, rawChunkData);
    this._updateRegionManifest(chunkPath, metadata);

    return {
      x: chunkX,
      z: chunkZ,
      path: chunkPath,
      timestamp: metadata.timestamp_utc,
      section_count: Array.isArray(metadata.sections) ? metadata.sections.length : 0,
    };
  }

  rebuildRegionFiles() {
    throw new Error(
      "Anvil region conversion is intentionally stubbed. Use world/region/chunk_index.json and output/chunks/*.bin as the future .mca inputs.",
    );
  }

  _prepareStorage() {
    fs.mkdirSync(this.chunkDir, { recursive: true });
    fs.mkdirSync(this.regionDir, { recursive: true });
    if (!fs.existsSync(this.manifestPath)) {
      fs.writeFileSync(
        this.manifestPath,
        stringifyJson({
          format: "minecraft_region_manifest/v1",
          minecraft_versions: [this.protocol.minecraftVersion],
          protocol_versions: [this.protocol.protocolVersion],
          data_versions: [this.protocol.dataVersion],
          generated_at_unix_ms: Date.now(),
          regions: {},
        }, true),
        "utf8",
      );
    }
  }

  _readHeightmaps(reader) {
    if (this.protocol.features.levelChunkHeightmapsFormat === "varint") {
      const heightmapCount = reader.readVarInt();
      const heightmaps = [];
      for (let index = 0; index < heightmapCount; index += 1) {
        const heightmapType = reader.readVarInt();
        const longCount = reader.readVarInt();
        const values = Array.from({ length: longCount }, () => reader.readUnsignedLong());
        heightmaps.push({
          type_id: heightmapType,
          long_count: longCount,
          values,
        });
      }
      return heightmaps;
    }

    const [, root] = readNbtRoot(reader);
    if (root.tagId !== 10) {
      throw new ProtocolError(`Expected compound heightmaps root, got tag id ${root.tagId}`);
    }

    const heightmaps = [];
    for (const [name, value] of Object.entries(root.value)) {
      if (value.tagId !== 12) {
        continue;
      }
      heightmaps.push({
        name,
        long_count: value.value.length,
        values: value.value.map((item) => BigInt(item)),
      });
    }
    return heightmaps;
  }

  _splitChunkData(rawChunkData, expectedSectionCount) {
    const reader = new ByteReader(rawChunkData);
    const sections = [];

    for (let sectionIndex = 0; sectionIndex < expectedSectionCount; sectionIndex += 1) {
      if (reader.remaining <= 0) {
        break;
      }

      const sectionOffset = reader.index;
      const blockCount = reader.readShort();
      const blockStates = this._readPalettedContainer(reader, {
        entryCount: 16 * 16 * 16,
        kind: "block_states",
      });
      const biomes = this._readPalettedContainer(reader, {
        entryCount: 4 * 4 * 4,
        kind: "biomes",
      });

      sections.push({
        section_index: sectionIndex,
        offset: sectionOffset,
        length: reader.index - sectionOffset,
        block_count: blockCount,
        block_states: blockStates,
        biomes,
      });
    }

    return [sections, reader.remaining];
  }

  _readPalettedContainer(reader, { entryCount, kind }) {
    const start = reader.index;
    const bitsPerEntry = reader.readUnsignedByte();
    const hasDataArrayLength = this.protocol.features.palettedContainerHasDataArrayLength;

    let mode;
    let paletteLength;
    let singleValue = null;
    let dataArrayLength = 0;

    if (bitsPerEntry === 0) {
      mode = "single_valued";
      paletteLength = 1;
      singleValue = reader.readVarInt();
      if (hasDataArrayLength) {
        dataArrayLength = reader.readVarInt();
        if (dataArrayLength !== 0) {
          throw new ProtocolError(
            `Unexpected ${kind} data array length ${dataArrayLength} for single-valued container`,
          );
        }
      }
    } else {
      const indirect = kind === "block_states"
        ? bitsPerEntry >= 4 && bitsPerEntry <= 8
        : bitsPerEntry >= 1 && bitsPerEntry <= 3;

      if (indirect) {
        mode = "indirect";
        paletteLength = reader.readVarInt();
        for (let index = 0; index < paletteLength; index += 1) {
          reader.readVarInt();
        }
      } else {
        mode = "direct";
        paletteLength = 0;
      }

      const expectedLength = calculateRequiredLongs(entryCount, bitsPerEntry);
      if (hasDataArrayLength) {
        dataArrayLength = reader.readVarInt();
        if (dataArrayLength !== expectedLength) {
          throw new ProtocolError(
            `Unexpected ${kind} data array length ${dataArrayLength}; expected ${expectedLength} for ${entryCount} entries at ${bitsPerEntry} bits`,
          );
        }
      } else {
        dataArrayLength = expectedLength;
      }
      reader.skip(dataArrayLength * 8);
    }

    const end = reader.index;
    return {
      offset: start,
      length: end - start,
      bits_per_entry: bitsPerEntry,
      mode,
      palette_length: paletteLength,
      single_value: singleValue,
      data_array_length: dataArrayLength,
    };
  }

  _parseTrailingPayload(reader) {
    const blockEntityCount = reader.readVarInt();
    const blockEntities = [];

    for (let index = 0; index < blockEntityCount; index += 1) {
      const entryStart = reader.index;
      const packedXz = reader.readUnsignedByte();
      const y = reader.readShort();
      const typeId = reader.readVarInt();
      const nbtRootType = reader.readUnsignedByte();
      if (nbtRootType !== 0) {
        skipNbtPayload(reader, nbtRootType);
      }

      blockEntities.push({
        offset: entryStart,
        length: reader.index - entryStart,
        x_in_chunk: packedXz >> 4,
        z_in_chunk: packedXz & 0x0f,
        y,
        type_id: typeId,
        nbt_root_type: nbtRootType,
      });
    }

    const lightUpdateStart = reader.index;
    const skyLightMask = this._readLongArray(reader);
    const blockLightMask = this._readLongArray(reader);
    const emptySkyLightMask = this._readLongArray(reader);
    const emptyBlockLightMask = this._readLongArray(reader);
    const skyLightArrays = this._readByteArrays(reader);
    const blockLightArrays = this._readByteArrays(reader);

    const lightUpdate = {
      offset: lightUpdateStart,
      length: reader.index - lightUpdateStart,
      sky_light_mask: skyLightMask,
      block_light_mask: blockLightMask,
      empty_sky_light_mask: emptySkyLightMask,
      empty_block_light_mask: emptyBlockLightMask,
      sky_light_arrays: skyLightArrays,
      block_light_arrays: blockLightArrays,
    };

    return [blockEntities, lightUpdate, reader.remaining];
  }

  _readLongArray(reader) {
    const offset = reader.index;
    const count = reader.readVarInt();
    const values = Array.from({ length: count }, () => reader.readUnsignedLong());
    return {
      offset,
      long_count: count,
      values,
    };
  }

  _readByteArrays(reader) {
    const arrayCount = reader.readVarInt();
    const arrays = [];
    for (let index = 0; index < arrayCount; index += 1) {
      const offset = reader.index;
      const byteCount = reader.readVarInt();
      reader.skip(byteCount);
      arrays.push({
        offset,
        length: byteCount,
      });
    }
    return arrays;
  }

  _writeChunkFile(chunkPath, metadata, packetPayload, rawChunkData) {
    const header = Buffer.from(stringifyJson(metadata), "utf8");
    const lengths = Buffer.alloc(12);
    lengths.writeUInt32BE(header.length, 0);
    lengths.writeUInt32BE(packetPayload.length, 4);
    lengths.writeUInt32BE(rawChunkData.length, 8);
    fs.writeFileSync(
      chunkPath,
      Buffer.concat([CHUNK_FILE_MAGIC, lengths, header, Buffer.from(packetPayload), Buffer.from(rawChunkData)]),
    );
  }

  _updateRegionManifest(chunkPath, metadata) {
    const manifest = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
    const manifestVersions = new Set(manifest.minecraft_versions || []);
    manifestVersions.add(String(metadata.minecraft_version));
    manifest.minecraft_versions = Array.from(manifestVersions).sort();

    const protocolVersions = new Set((manifest.protocol_versions || []).map((item) => Number(item)));
    protocolVersions.add(Number(metadata.protocol_version));
    manifest.protocol_versions = Array.from(protocolVersions).sort((a, b) => a - b);

    const dataVersions = new Set((manifest.data_versions || []).map((item) => Number(item)));
    dataVersions.add(Number(metadata.data_version));
    manifest.data_versions = Array.from(dataVersions).sort((a, b) => a - b);

    const chunkX = Number(metadata.chunk_x);
    const chunkZ = Number(metadata.chunk_z);
    const regionX = Math.floor(chunkX / 32);
    const regionZ = Math.floor(chunkZ / 32);
    const regionKey = `r.${regionX}.${regionZ}.mca`;

    manifest.regions = manifest.regions || {};
    manifest.regions[regionKey] = manifest.regions[regionKey] || {
      region_x: regionX,
      region_z: regionZ,
      chunks: {},
    };

    manifest.regions[regionKey].chunks[`${chunkX},${chunkZ}`] = {
      chunk_x: chunkX,
      chunk_z: chunkZ,
      chunk_path: chunkPath.split(path.sep).join("/"),
      timestamp_utc: metadata.timestamp_utc,
    };
    manifest.generated_at_unix_ms = Date.now();

    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }
}

module.exports = {
  CHUNK_FILE_MAGIC,
  ChunkHandler,
};

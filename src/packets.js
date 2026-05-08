const fs = require("fs");
const path = require("path");

const PROTOCOL_VERSION = 775;

const ASSETS_ROOT = path.join(__dirname, "assets");
const METADATA_FILE_NAME = "metadata.json";

const DIMENSION_SECTION_COUNTS = {
  "minecraft:overworld": 24,
  "minecraft:the_nether": 16,
  "minecraft:the_end": 16,
};

const PROTOCOL_FEATURES = {
  763: {
    usesConfigurationState: false,
    loginStartHasOptionalUuid: true,
    clientInformationState: "play",
    clientInformationHasParticleStatus: false,
    configurationJoinGameIsLegacy: false,
    playPositionTeleportIdFirst: false,
    resourcePackResponseHasUuid: false,
    levelChunkHeightmapsFormat: "nbt",
    levelChunkHeightmapsNbtRoot: "named",
    chunkSectionHasFluidCount: false,
    palettedContainerHasDataArrayLength: true,
    supportsChunkBatching: false,
    sendsPlayerLoaded: false,
    sendsPositionAfterTeleport: true,
  },
  764: {
    usesConfigurationState: true,
    loginStartHasOptionalUuid: false,
    clientInformationState: "configuration",
    clientInformationHasParticleStatus: false,
    configurationJoinGameIsLegacy: true,
    playPositionTeleportIdFirst: false,
    resourcePackResponseHasUuid: false,
    levelChunkHeightmapsFormat: "nbt",
    levelChunkHeightmapsNbtRoot: "anonymous",
    chunkSectionHasFluidCount: false,
    palettedContainerHasDataArrayLength: true,
    supportsChunkBatching: true,
    sendsPlayerLoaded: false,
    sendsPositionAfterTeleport: true,
  },
  765: {
    usesConfigurationState: true,
    loginStartHasOptionalUuid: false,
    clientInformationState: "configuration",
    clientInformationHasParticleStatus: false,
    configurationJoinGameIsLegacy: true,
    playPositionTeleportIdFirst: false,
    resourcePackResponseHasUuid: true,
    levelChunkHeightmapsFormat: "nbt",
    levelChunkHeightmapsNbtRoot: "anonymous",
    chunkSectionHasFluidCount: false,
    palettedContainerHasDataArrayLength: true,
    supportsChunkBatching: true,
    sendsPlayerLoaded: false,
    sendsPositionAfterTeleport: true,
  },
  770: {
    usesConfigurationState: true,
    loginStartHasOptionalUuid: false,
    clientInformationState: "configuration",
    clientInformationHasParticleStatus: true,
    configurationJoinGameIsLegacy: false,
    playPositionTeleportIdFirst: true,
    resourcePackResponseHasUuid: true,
    levelChunkHeightmapsFormat: "varint",
    levelChunkHeightmapsNbtRoot: "anonymous",
    chunkSectionHasFluidCount: false,
    palettedContainerHasDataArrayLength: false,
    supportsChunkBatching: true,
    sendsPlayerLoaded: true,
    sendsPositionAfterTeleport: false,
  },
  771: {
    usesConfigurationState: true,
    loginStartHasOptionalUuid: false,
    clientInformationState: "configuration",
    clientInformationHasParticleStatus: true,
    configurationJoinGameIsLegacy: false,
    playPositionTeleportIdFirst: true,
    resourcePackResponseHasUuid: true,
    levelChunkHeightmapsFormat: "varint",
    levelChunkHeightmapsNbtRoot: "anonymous",
    chunkSectionHasFluidCount: false,
    palettedContainerHasDataArrayLength: false,
    supportsChunkBatching: true,
    sendsPlayerLoaded: true,
    sendsPositionAfterTeleport: false,
  },
  772: {
    usesConfigurationState: true,
    loginStartHasOptionalUuid: false,
    clientInformationState: "configuration",
    clientInformationHasParticleStatus: true,
    configurationJoinGameIsLegacy: false,
    playPositionTeleportIdFirst: true,
    resourcePackResponseHasUuid: true,
    levelChunkHeightmapsFormat: "varint",
    levelChunkHeightmapsNbtRoot: "anonymous",
    chunkSectionHasFluidCount: false,
    palettedContainerHasDataArrayLength: false,
    supportsChunkBatching: true,
    sendsPlayerLoaded: true,
    sendsPositionAfterTeleport: false,
  },
  773: {
    usesConfigurationState: true,
    loginStartHasOptionalUuid: false,
    clientInformationState: "configuration",
    clientInformationHasParticleStatus: true,
    configurationJoinGameIsLegacy: false,
    playPositionTeleportIdFirst: true,
    resourcePackResponseHasUuid: true,
    levelChunkHeightmapsFormat: "varint",
    levelChunkHeightmapsNbtRoot: "anonymous",
    chunkSectionHasFluidCount: false,
    palettedContainerHasDataArrayLength: false,
    supportsChunkBatching: true,
    sendsPlayerLoaded: true,
    sendsPositionAfterTeleport: false,
  },
  774: {
    usesConfigurationState: true,
    loginStartHasOptionalUuid: false,
    clientInformationState: "configuration",
    clientInformationHasParticleStatus: true,
    configurationJoinGameIsLegacy: false,
    playPositionTeleportIdFirst: true,
    resourcePackResponseHasUuid: true,
    levelChunkHeightmapsFormat: "varint",
    levelChunkHeightmapsNbtRoot: "anonymous",
    chunkSectionHasFluidCount: false,
    palettedContainerHasDataArrayLength: false,
    supportsChunkBatching: true,
    sendsPlayerLoaded: true,
    sendsPositionAfterTeleport: false,
  },
  775: {
    usesConfigurationState: true,
    loginStartHasOptionalUuid: false,
    clientInformationState: "configuration",
    clientInformationHasParticleStatus: true,
    configurationJoinGameIsLegacy: false,
    playPositionTeleportIdFirst: true,
    resourcePackResponseHasUuid: true,
    levelChunkHeightmapsFormat: "varint",
    levelChunkHeightmapsNbtRoot: "anonymous",
    chunkSectionHasFluidCount: true,
    palettedContainerHasDataArrayLength: false,
    supportsChunkBatching: true,
    sendsPlayerLoaded: true,
    sendsPositionAfterTeleport: false,
  },
};

class ProtocolSpec {
  constructor({
    protocolVersion,
    minecraftVersion,
    dataVersion,
    packets,
    reversePackets,
    assetsDir,
    blocksJsonPath,
    features,
  }) {
    this.protocolVersion = protocolVersion;
    this.minecraftVersion = minecraftVersion;
    this.dataVersion = dataVersion;
    this.packets = packets;
    this.reversePackets = reversePackets;
    this.assetsDir = assetsDir;
    this.blocksJsonPath = blocksJsonPath;
    this.features = features;
  }

  packetId(state, direction, name) {
    return this.packets[state][direction][name];
  }

  packetName(state, direction, packetIdValue) {
    const stateGroup = this.reversePackets[state] || {};
    const directionGroup = stateGroup[direction] || {};
    return directionGroup[packetIdValue] || `unknown_0x${packetIdValue.toString(16).padStart(2, "0")}`;
  }

  packetIdOrNone(state, direction, name) {
    return (((this.packets[state] || {})[direction] || {})[name]);
  }

  hasPacket(state, direction, name) {
    return this.packetIdOrNone(state, direction, name) != null;
  }
}

function normalizePacketName(name) {
  return String(name).split(":", 2).pop();
}

function normalizePackets(packetData) {
  const normalized = {};
  for (const [state, directions] of Object.entries(packetData)) {
    const stateDirections = {};
    for (const [direction, packets] of Object.entries(directions)) {
      const names = {};
      for (const [packetNameValue, metadata] of Object.entries(packets)) {
        const name = normalizePacketName(packetNameValue);
        if (metadata && typeof metadata === "object" && Object.prototype.hasOwnProperty.call(metadata, "protocol_id")) {
          names[name] = Number(metadata.protocol_id);
        } else {
          names[name] = Number(metadata);
        }
      }
      stateDirections[direction] = names;
    }
    normalized[state] = stateDirections;
  }
  return normalized;
}

function reversePackets(packets) {
  const reversed = {};
  for (const [state, directions] of Object.entries(packets)) {
    reversed[state] = {};
    for (const [direction, values] of Object.entries(directions)) {
      reversed[state][direction] = {};
      for (const [name, packetIdValue] of Object.entries(values)) {
        reversed[state][direction][packetIdValue] = name;
      }
    }
  }
  return reversed;
}

function metadataPath(protocolVersion) {
  return path.join(ASSETS_ROOT, String(protocolVersion), METADATA_FILE_NAME);
}

function packetsPath(protocolVersion) {
  return path.join(ASSETS_ROOT, String(protocolVersion), "packets.json");
}

function loadPackets(protocolVersion) {
  const filePath = packetsPath(protocolVersion);
  if (fs.existsSync(filePath)) {
    return normalizePackets(JSON.parse(fs.readFileSync(filePath, "utf8")));
  }
  throw new Error(`Missing ${filePath}. Generate assets for protocol ${protocolVersion} first.`);
}

function loadMetadata(protocolVersion) {
  const filePath = metadataPath(protocolVersion);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  throw new Error(`Missing ${filePath}. Generate assets for protocol ${protocolVersion} first.`);
}

const PROTOCOL_CACHE = new Map();

function loadProtocolSpec(protocolVersion = PROTOCOL_VERSION) {
  protocolVersion = Number(protocolVersion);
  if (PROTOCOL_CACHE.has(protocolVersion)) {
    return PROTOCOL_CACHE.get(protocolVersion);
  }

  if (!Object.prototype.hasOwnProperty.call(PROTOCOL_FEATURES, protocolVersion)) {
    const supported = Object.keys(PROTOCOL_FEATURES).sort((a, b) => Number(a) - Number(b)).join(", ");
    throw new Error(`Protocol ${protocolVersion} is not wired into the runtime yet. Supported protocol versions: ${supported}.`);
  }

  const metadata = loadMetadata(protocolVersion);
  const packets = loadPackets(protocolVersion);
  const assetsDir = path.join(ASSETS_ROOT, String(protocolVersion));
  const spec = new ProtocolSpec({
    protocolVersion,
    minecraftVersion: String(metadata.minecraft_version),
    dataVersion: Number(metadata.data_version),
    packets,
    reversePackets: reversePackets(packets),
    assetsDir,
    blocksJsonPath: path.join(assetsDir, "blocks.json"),
    features: PROTOCOL_FEATURES[protocolVersion],
  });
  PROTOCOL_CACHE.set(protocolVersion, spec);
  return spec;
}

function packetId(state, direction, name, protocolVersion = PROTOCOL_VERSION) {
  return loadProtocolSpec(protocolVersion).packetId(state, direction, name);
}

function packetName(state, direction, packetIdValue, protocolVersion = PROTOCOL_VERSION) {
  return loadProtocolSpec(protocolVersion).packetName(state, direction, packetIdValue);
}

module.exports = {
  PROTOCOL_VERSION,
  ASSETS_ROOT,
  METADATA_FILE_NAME,
  DIMENSION_SECTION_COUNTS,
  PROTOCOL_FEATURES,
  ProtocolSpec,
  normalizePacketName,
  normalizePackets,
  reversePackets,
  loadProtocolSpec,
  packetId,
  packetName,
};

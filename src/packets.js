const fs = require("fs");
const path = require("path");

const PROTOCOL_VERSION = 772;
const MINECRAFT_VERSION = "1.21.8";
const DATA_VERSION = 4440;

const ASSETS_ROOT = path.join(__dirname, "assets");
const METADATA_FILE_NAME = "metadata.json";

const DIMENSION_SECTION_COUNTS = {
  "minecraft:overworld": 24,
  "minecraft:the_nether": 16,
  "minecraft:the_end": 16,
};

const PACKETS_772 = {
  handshake: {
    clientbound: {},
    serverbound: {
      intention: 0x00,
    },
  },
  login: {
    clientbound: {
      login_disconnect: 0x00,
      hello: 0x01,
      login_finished: 0x02,
      login_compression: 0x03,
      custom_query: 0x04,
      cookie_request: 0x05,
    },
    serverbound: {
      hello: 0x00,
      key: 0x01,
      custom_query_answer: 0x02,
      login_acknowledged: 0x03,
      cookie_response: 0x04,
    },
  },
  configuration: {
    clientbound: {
      cookie_request: 0x00,
      custom_payload: 0x01,
      disconnect: 0x02,
      finish_configuration: 0x03,
      keep_alive: 0x04,
      ping: 0x05,
      reset_chat: 0x06,
      registry_data: 0x07,
      resource_pack_pop: 0x08,
      resource_pack_push: 0x09,
      store_cookie: 0x0a,
      transfer: 0x0b,
      update_enabled_features: 0x0c,
      update_tags: 0x0d,
      select_known_packs: 0x0e,
      custom_report_details: 0x0f,
      server_links: 0x10,
      clear_dialog: 0x11,
      show_dialog: 0x12,
    },
    serverbound: {
      client_information: 0x00,
      cookie_response: 0x01,
      custom_payload: 0x02,
      finish_configuration: 0x03,
      keep_alive: 0x04,
      pong: 0x05,
      resource_pack: 0x06,
      select_known_packs: 0x07,
      custom_click_action: 0x08,
    },
  },
  play: {
    clientbound: {
      bundle_delimiter: 0x00,
      add_entity: 0x01,
      block_update: 0x08,
      chunk_batch_finished: 0x0b,
      chunk_batch_start: 0x0c,
      chunks_biomes: 0x0d,
      cookie_request: 0x15,
      custom_payload: 0x18,
      disconnect: 0x19,
      forget_level_chunk: 0x23,
      keep_alive: 0x26,
      level_chunk_with_light: 0x27,
      light_update: 0x2c,
      login: 0x2b,
      ping: 0x36,
      player_info_update: 0x3a,
      player_position: 0x41,
      resource_pack_pop: 0x47,
      resource_pack_push: 0x48,
      section_blocks_update: 0x4c,
      set_chunk_cache_center: 0x57,
      set_chunk_cache_radius: 0x58,
      set_default_spawn_position: 0x59,
      set_entity_motion: 0x5a,
      set_health: 0x5c,
      set_time: 0x66,
      sound: 0x6a,
      tab_list: 0x70,
    },
    serverbound: {
      accept_teleportation: 0x00,
      chunk_batch_received: 0x0a,
      client_information: 0x0d,
      client_command: 0x0b,
      cookie_response: 0x14,
      keep_alive: 0x1b,
      player_loaded: 0x2b,
      pong: 0x2c,
      resource_pack: 0x30,
    },
  },
};

const PACKETS_BY_PROTOCOL = {
  772: PACKETS_772,
};

const METADATA_BY_PROTOCOL = {
  772: {
    minecraft_version: MINECRAFT_VERSION,
    data_version: DATA_VERSION,
  },
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
    palettedContainerHasDataArrayLength: true,
    supportsChunkBatching: false,
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
  if (Object.prototype.hasOwnProperty.call(PACKETS_BY_PROTOCOL, protocolVersion)) {
    return PACKETS_BY_PROTOCOL[protocolVersion];
  }
  throw new Error(`Missing ${filePath}. Generate assets for protocol ${protocolVersion} first.`);
}

function loadMetadata(protocolVersion) {
  const filePath = metadataPath(protocolVersion);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  if (Object.prototype.hasOwnProperty.call(METADATA_BY_PROTOCOL, protocolVersion)) {
    return METADATA_BY_PROTOCOL[protocolVersion];
  }
  throw new Error(`Missing ${filePath}. Generate assets for protocol ${protocolVersion} first.`);
}

const PROTOCOL_CACHE = new Map();

function loadProtocolSpec(protocolVersion = PROTOCOL_VERSION) {
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
  MINECRAFT_VERSION,
  DATA_VERSION,
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

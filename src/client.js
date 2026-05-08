const net = require("net");
const { performance } = require("perf_hooks");

const { ChunkHandler } = require("./chunk_handler");
const {
  PROTOCOL_VERSION,
  DIMENSION_SECTION_COUNTS,
  loadProtocolSpec,
} = require("./packets");
const {
  ByteReader,
  ByteWriter,
  ConnectionClosed,
  PacketStream,
  ProtocolError,
  StreamTimeoutError,
  offlineUuid,
  skipNbtRoot,
} = require("./protocol");

function monotonicSeconds() {
  return performance.now() / 1000;
}

function connectSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };

    const onConnect = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    };

    const onError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error(`Connection timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

class MinecraftClient {
  constructor({
    serverIp,
    serverPort,
    username,
    protocolVersion = PROTOCOL_VERSION,
    outputRoot = "output",
    worldRoot = "world",
    viewDistance = 127,
    connectTimeout = 10.0,
    readTimeout = 180.0,
    maxCaptureSeconds = 180.0,
    logger = console,
    eventEmitter = null,
  }) {
    this.serverIp = serverIp;
    this.serverPort = serverPort;
    this.username = username;
    this.protocol = loadProtocolSpec(protocolVersion);
    this.protocolVersion = this.protocol.protocolVersion;
    this.viewDistance = Math.max(2, Math.min(Number(viewDistance), 127));
    this.connectTimeout = Number(connectTimeout);
    this.readTimeout = Number(readTimeout);
    this.maxCaptureSeconds = Math.max(1.0, Number(maxCaptureSeconds));
    this.logger = logger;
    this.eventEmitter = eventEmitter;

    this.socket = null;
    this.stream = null;
    this.chunkHandler = new ChunkHandler({
      outputRoot,
      worldRoot,
      protocol: this.protocol,
      logger: this.logger,
    });

    this.state = "handshake";
    this.compressionThreshold = -1;
    this.dimensionName = "minecraft:overworld";
    this.expectedSectionCount = DIMENSION_SECTION_COUNTS[this.dimensionName];
    this.centerChunk = null;
    this.chunkCount = 0;
    this.batchStartedAt = null;
    this.playStartedAt = null;
    this.captureDeadline = null;
  }

  async run() {
    await this._connect();
    try {
      this._sendHandshake();
      this._sendLoginStart();

      while (true) {
        if (this._captureWindowExpired()) {
          this.logger.info(
            "Capture window reached %ss; closing connection with %d chunk(s) saved",
            this.maxCaptureSeconds.toFixed(1),
            this.chunkCount,
          );
          break;
        }

        const [packetIdValue, payload] = await this._stream.readPacket(
          this.compressionThreshold,
          this._currentReadTimeoutMs(),
        );
        const packetNameValue = this.protocol.packetName(this.state, "clientbound", packetIdValue);
        this.logger.info(
          "Received %s packet 0x%s (%s)",
          this.state,
          packetIdValue.toString(16).toUpperCase().padStart(2, "0"),
          packetNameValue,
        );

        if (this.state === "login") {
          this._handleLogin(packetIdValue, payload);
        } else if (this.state === "configuration") {
          this._handleConfiguration(packetIdValue, payload);
        } else if (this.state === "play") {
          this._handlePlay(packetIdValue, payload);
        } else {
          throw new ProtocolError(`Unhandled state ${this.state}`);
        }
      }
    } catch (error) {
      if (error instanceof ConnectionClosed) {
        this.logger.info("Connection closed: %s", error.message);
      } else if (error instanceof StreamTimeoutError) {
        if (this._captureWindowExpired()) {
          this.logger.info(
            "Capture window reached %ss; closing connection with %d chunk(s) saved",
            this.maxCaptureSeconds.toFixed(1),
            this.chunkCount,
          );
        } else {
          this.logger.warning("Socket timeout while waiting for server data: %s", error.message);
        }
      } else if (error instanceof ProtocolError) {
        if (this._shouldKeepCapturedChunks(error)) {
          this.logger.info(
            "Server disconnected during play after %d chunk(s); keeping captured chunks",
            this.chunkCount,
          );
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    } finally {
      this.close();
    }
  }

  close() {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      this.stream = null;
      socket.destroy();
    }
  }

  get _stream() {
    if (!this.stream) {
      throw new ProtocolError("Packet stream is not ready");
    }
    return this.stream;
  }

  async _connect() {
    this.logger.info(
      "Connecting to %s:%s using protocol %s (%s)",
      this.serverIp,
      this.serverPort,
      this.protocolVersion,
      this.protocol.minecraftVersion,
    );
    const socket = await connectSocket(this.serverIp, this.serverPort, this.connectTimeout * 1000);
    socket.setNoDelay(true);
    this.socket = socket;
    this.stream = new PacketStream(socket);
  }

  _matchesPacket(state, direction, name, packetIdValue) {
    const expected = this.protocol.packetIdOrNone(state, direction, name);
    return expected != null && expected === packetIdValue;
  }

  _sendHandshake() {
    const writer = new ByteWriter();
    writer.writeVarInt(this.protocolVersion);
    writer.writeString(this.serverIp);
    writer.writeUShort(this.serverPort);
    writer.writeVarInt(2);
    this._send("handshake", "serverbound", "intention", writer.toBuffer());
    this.state = "login";
    this.logger.info("Sent handshake, switching to login state");
  }

  _sendLoginStart() {
    const writer = new ByteWriter();
    writer.writeString(this.username);
    if (this.protocol.features.loginStartHasOptionalUuid) {
      writer.writeBool(false);
    } else {
      writer.writeUuid(offlineUuid(this.username));
    }
    this._send("login", "serverbound", "hello", writer.toBuffer());
    this.logger.info("Sent login start for offline username %s", this.username);
  }

  _send(state, direction, name, payload = Buffer.alloc(0)) {
    const packetValue = this.protocol.packetId(state, direction, name);
    this._stream.sendPacket(packetValue, payload, this.compressionThreshold);
    this.logger.info("Sent %s packet 0x%s (%s)", state, packetValue.toString(16).toUpperCase().padStart(2, "0"), name);
  }

  _handleLogin(packetIdValue, payload) {
    const reader = new ByteReader(payload);

    if (this._matchesPacket("login", "clientbound", "hello", packetIdValue)) {
      throw new ProtocolError(
        "The server requested online-mode encryption. This client only supports offline mode servers.",
      );
    }
    if (this._matchesPacket("login", "clientbound", "login_compression", packetIdValue)) {
      this.compressionThreshold = reader.readVarInt();
      this.logger.info("Compression enabled at threshold %s", this.compressionThreshold);
      return;
    }
    if (this._matchesPacket("login", "clientbound", "login_finished", packetIdValue)) {
      if (this.protocol.features.usesConfigurationState) {
        this._send("login", "serverbound", "login_acknowledged");
        this._sendClientInformation();
        this.state = "configuration";
        this.logger.info("Login finished, switching to configuration state");
      } else {
        this.state = "play";
        this.logger.info("Login finished, switching directly to play state");
      }
      return;
    }
    if (this._matchesPacket("login", "clientbound", "custom_query", packetIdValue)) {
      const transactionId = reader.readVarInt();
      const response = new ByteWriter();
      response.writeVarInt(transactionId);
      response.writeBool(false);
      this._send("login", "serverbound", "custom_query_answer", response.toBuffer());
      return;
    }
    if (this._matchesPacket("login", "clientbound", "cookie_request", packetIdValue)) {
      const cookieId = reader.readString();
      const response = new ByteWriter();
      response.writeString(cookieId);
      response.writeBool(false);
      this._send("login", "serverbound", "cookie_response", response.toBuffer());
      return;
    }
    if (this._matchesPacket("login", "clientbound", "login_disconnect", packetIdValue)) {
      throw new ProtocolError(`Disconnected during login; payload was ${payload.toString("hex")}`);
    }
  }

  _sendClientInformation() {
    const writer = new ByteWriter();
    writer.writeString("en_GB");
    writer.writeByte(this.viewDistance);
    writer.writeVarInt(0);
    writer.writeBool(true);
    writer.writeUnsignedByte(0xff);
    writer.writeVarInt(1);
    writer.writeBool(false);
    writer.writeBool(false);
    if (this.protocol.features.clientInformationHasParticleStatus) {
      writer.writeVarInt(0);
    }
    this._send(
      this.protocol.features.clientInformationState,
      "serverbound",
      "client_information",
      writer.toBuffer(),
    );
  }

  _handleConfiguration(packetIdValue, payload) {
    const reader = new ByteReader(payload);

    if (this._matchesPacket("configuration", "clientbound", "cookie_request", packetIdValue)) {
      const cookieId = reader.readString();
      const response = new ByteWriter();
      response.writeString(cookieId);
      response.writeBool(false);
      this._send("configuration", "serverbound", "cookie_response", response.toBuffer());
      return;
    }

    if (this._matchesPacket("configuration", "clientbound", "keep_alive", packetIdValue)) {
      const keepAliveId = reader.readLong();
      const response = new ByteWriter();
      response.writeLong(keepAliveId);
      this._send("configuration", "serverbound", "keep_alive", response.toBuffer());
      return;
    }

    if (this._matchesPacket("configuration", "clientbound", "ping", packetIdValue)) {
      const pingId = reader.readInt();
      const response = new ByteWriter();
      response.writeInt(pingId);
      this._send("configuration", "serverbound", "pong", response.toBuffer());
      return;
    }

    if (this._matchesPacket("configuration", "clientbound", "resource_pack_push", packetIdValue)) {
      const response = new ByteWriter();
      if (this.protocol.features.resourcePackResponseHasUuid) {
        const packId = reader.readUuid();
        response.writeUuid(packId);
      }
      response.writeVarInt(3);
      this._send("configuration", "serverbound", "resource_pack", response.toBuffer());
      return;
    }

    if (this._matchesPacket("configuration", "clientbound", "select_known_packs", packetIdValue)) {
      const packCount = reader.readVarInt();
      const response = new ByteWriter();
      response.writeVarInt(packCount);
      for (let index = 0; index < packCount; index += 1) {
        const namespace = reader.readString();
        const packName = reader.readString();
        const version = reader.readString();
        response.writeString(namespace);
        response.writeString(packName);
        response.writeString(version);
      }
      this._send("configuration", "serverbound", "select_known_packs", response.toBuffer());
      return;
    }

    if (this._matchesPacket("configuration", "clientbound", "code_of_conduct", packetIdValue)) {
      if (this.protocol.hasPacket("configuration", "serverbound", "accept_code_of_conduct")) {
        this._send("configuration", "serverbound", "accept_code_of_conduct");
      }
      return;
    }

    if (this._matchesPacket("configuration", "clientbound", "finish_configuration", packetIdValue)) {
      this.state = "play";
      this._send("configuration", "serverbound", "finish_configuration");
      this.logger.info("Configuration finished, switching to play state");
      return;
    }

    if (this._matchesPacket("configuration", "clientbound", "disconnect", packetIdValue)) {
      throw new ProtocolError(`Disconnected during configuration; payload was ${payload.toString("hex")}`);
    }
  }

  _handlePlay(packetIdValue, payload) {
    const reader = new ByteReader(payload);

    if (this._matchesPacket("play", "clientbound", "keep_alive", packetIdValue)) {
      const keepAliveId = reader.readLong();
      const response = new ByteWriter();
      response.writeLong(keepAliveId);
      this._send("play", "serverbound", "keep_alive", response.toBuffer());
      return;
    }

    if (this._matchesPacket("play", "clientbound", "ping", packetIdValue)) {
      const pingId = reader.readInt();
      const response = new ByteWriter();
      response.writeInt(pingId);
      this._send("play", "serverbound", "pong", response.toBuffer());
      return;
    }

    if (this._matchesPacket("play", "clientbound", "login", packetIdValue)) {
      this._handleJoinGame(payload);
      if (!this.protocol.features.usesConfigurationState) {
        this._sendClientInformation();
      }
      if (this.protocol.features.sendsPlayerLoaded) {
        this._send("play", "serverbound", "player_loaded");
      }
      return;
    }

    if (this._matchesPacket("play", "clientbound", "player_position", packetIdValue)) {
      let teleportId;
      let x;
      let y;
      let z;

      if (this.protocol.features.playPositionTeleportIdFirst) {
        teleportId = reader.readVarInt();
        x = reader.readDouble();
        y = reader.readDouble();
        z = reader.readDouble();
      } else {
        x = reader.readDouble();
        y = reader.readDouble();
        z = reader.readDouble();
        reader.readFloat();
        reader.readFloat();
        reader.readByte();
        teleportId = reader.readVarInt();
      }

      const response = new ByteWriter();
      response.writeVarInt(teleportId);
      this._send("play", "serverbound", "accept_teleportation", response.toBuffer());

      if (this.protocol.features.sendsPositionAfterTeleport) {
        this._sendLegacyPositionAck({ x, y, z });
      }
      return;
    }

    if (this.protocol.features.supportsChunkBatching && this._matchesPacket("play", "clientbound", "chunk_batch_start", packetIdValue)) {
      this.batchStartedAt = monotonicSeconds();
      return;
    }

    if (this.protocol.features.supportsChunkBatching && this._matchesPacket("play", "clientbound", "chunk_batch_finished", packetIdValue)) {
      const receivedChunks = Math.max(reader.readVarInt(), 1);
      let chunksPerTick = 20.0;

      if (this.batchStartedAt != null) {
        const elapsed = Math.max(monotonicSeconds() - this.batchStartedAt, 0.001);
        const millisecondsPerChunk = (elapsed * 1000.0) / receivedChunks;
        chunksPerTick = Math.max(0.01, 25.0 / millisecondsPerChunk);
      }

      const response = new ByteWriter();
      response.writeFloat(chunksPerTick);
      this._send("play", "serverbound", "chunk_batch_received", response.toBuffer());
      return;
    }

    if (this._matchesPacket("play", "clientbound", "level_chunk_with_light", packetIdValue)) {
      const result = this.chunkHandler.saveChunkPacket(payload, {
        dimensionName: this.dimensionName,
        expectedSectionCount: this.expectedSectionCount,
      });
      this.chunkCount += 1;
      this.logger.info(
        "Chunk received at X: %s, Z: %s (%s total)",
        result.x,
        result.z,
        this.chunkCount,
      );
      if (this.eventEmitter) {
        this.eventEmitter.emit("chunk", result);
      }
      return;
    }

    if (this._matchesPacket("play", "clientbound", "set_chunk_cache_center", packetIdValue)) {
      const centerX = reader.readVarInt();
      const centerZ = reader.readVarInt();
      this.centerChunk = [centerX, centerZ];
      this.logger.info("Set chunk cache center to X: %s, Z: %s", centerX, centerZ);
      return;
    }

    if (this._matchesPacket("play", "clientbound", "cookie_request", packetIdValue)) {
      const cookieId = reader.readString();
      const response = new ByteWriter();
      response.writeString(cookieId);
      response.writeBool(false);
      this._send("play", "serverbound", "cookie_response", response.toBuffer());
      return;
    }

    if (this._matchesPacket("play", "clientbound", "resource_pack_push", packetIdValue)) {
      const response = new ByteWriter();
      if (this.protocol.features.resourcePackResponseHasUuid) {
        const packId = reader.readUuid();
        response.writeUuid(packId);
      }
      response.writeVarInt(3);
      this._send("play", "serverbound", "resource_pack", response.toBuffer());
      return;
    }

    if (this._matchesPacket("play", "clientbound", "set_health", packetIdValue) ||
        this._matchesPacket("play", "clientbound", "update_health", packetIdValue)) {
      const health = reader.readFloat();
      reader.readVarInt(); // food
      reader.readFloat(); // saturation
      
      if (health <= 0) {
        this.logger.info("Bot died (health: %s). Sending respawn command...", health);
        this._sendRespawn();
      }
      return;
    }

    if (this._matchesPacket("play", "clientbound", "disconnect", packetIdValue)) {
      throw new ProtocolError(`Disconnected during play; payload was ${payload.toString("hex")}`);
    }
  }

  _sendRespawn() {
    if (!this.protocol.hasPacket("play", "serverbound", "client_command")) {
      this.logger.warning("Protocol does not support client_command; cannot auto-respawn");
      return;
    }

    const writer = new ByteWriter();
    writer.writeVarInt(0); // Action ID 0: Perform respawn
    this._send("play", "serverbound", "client_command", writer.toBuffer());
  }

  _sendLegacyPositionAck({ x, y, z }) {
    if (!this.protocol.hasPacket("play", "serverbound", "position")) {
      return;
    }

    const writer = new ByteWriter();
    writer.writeDouble(x);
    writer.writeDouble(y);
    writer.writeDouble(z);
    writer.writeBool(false);
    this._send("play", "serverbound", "position", writer.toBuffer());
  }

  _handleJoinGame(payload) {
    const reader = new ByteReader(payload);
    const entityId = reader.readInt();
    reader.readBool();

    let dimensionName;
    let viewDistance;
    let simulationDistance;
    let dimensionNames;

    if (this.protocol.features.usesConfigurationState) {
      const dimensionNameCount = reader.readVarInt();
      dimensionNames = Array.from({ length: dimensionNameCount }, () => reader.readString());
      reader.readVarInt();
      viewDistance = reader.readVarInt();
      simulationDistance = reader.readVarInt();
      reader.readBool();
      reader.readBool();
      reader.readBool();
      if (this.protocol.features.configurationJoinGameIsLegacy) {
        reader.readString();
        dimensionName = reader.readString();
        reader.readLong();
        reader.readUnsignedByte();
        reader.readByte();
        reader.readBool();
        reader.readBool();

        const hasDeathLocation = reader.readBool();
        if (hasDeathLocation) {
          reader.readString();
          reader.readLong();
        }
        reader.readVarInt();
      } else {
        reader.readVarInt();
        dimensionName = reader.readString();
      }
    } else {
      reader.readUnsignedByte();
      reader.readByte();
      const dimensionNameCount = reader.readVarInt();
      dimensionNames = Array.from({ length: dimensionNameCount }, () => reader.readString());
      skipNbtRoot(reader);
      reader.readString();
      dimensionName = reader.readString();
      reader.readLong();
      reader.readVarInt();
      viewDistance = reader.readVarInt();
      simulationDistance = reader.readVarInt();
      reader.readBool();
      reader.readBool();
      reader.readBool();
      reader.readBool();

      const hasDeathLocation = reader.readBool();
      if (hasDeathLocation) {
        reader.readString();
        reader.readLong();
      }
      reader.readVarInt();
    }

    this.dimensionName = dimensionName;
    this.expectedSectionCount = DIMENSION_SECTION_COUNTS[dimensionName] || 24;
    this.logger.info(
      "Joined world as entity %s in %s (server view distance %s, simulation distance %s, available dimensions %s)",
      entityId,
      dimensionName,
      viewDistance,
      simulationDistance,
      JSON.stringify(dimensionNames),
    );
    this._startCaptureWindow();
  }

  _startCaptureWindow() {
    if (this.playStartedAt != null) {
      return;
    }

    this.playStartedAt = monotonicSeconds();
    this.captureDeadline = this.playStartedAt + this.maxCaptureSeconds;
    this.logger.info("Capture window started for %s seconds", this.maxCaptureSeconds.toFixed(1));
  }

  _captureWindowExpired() {
    return this.captureDeadline != null && monotonicSeconds() >= this.captureDeadline;
  }

  _currentReadTimeoutMs() {
    let timeout = this.readTimeout;
    if (this.captureDeadline != null) {
      const remaining = this.captureDeadline - monotonicSeconds();
      timeout = Math.max(0.1, Math.min(this.readTimeout, remaining));
    }
    return Math.round(timeout * 1000);
  }

  _shouldKeepCapturedChunks(error) {
    if (this.chunkCount <= 0) {
      return false;
    }
    const message = String(error.message || error).toLowerCase();
    return this.state === "play" && message.includes("disconnected during play");
  }
}

module.exports = {
  MinecraftClient,
};

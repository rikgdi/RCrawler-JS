const crypto = require("crypto");
const zlib = require("zlib");

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

const MAX_VARINT_BYTES = 5;

class ProtocolError extends Error {}

class ConnectionClosed extends ProtocolError {}

class StreamTimeoutError extends Error {}

class NBTValue {
  constructor(tagId, value) {
    this.tagId = tagId;
    this.value = value;
  }
}

function nbtByte(value) {
  return new NBTValue(TAG_BYTE, value);
}

function nbtInt(value) {
  return new NBTValue(TAG_INT, value);
}

function nbtLong(value) {
  return new NBTValue(TAG_LONG, BigInt(value));
}

function nbtString(value) {
  return new NBTValue(TAG_STRING, String(value));
}

function nbtCompound(value) {
  return new NBTValue(TAG_COMPOUND, value);
}

function encodeVarInt(value) {
  let remaining = Number(value) >>> 0;
  const output = [];

  while (true) {
    const current = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) {
      output.push(current | 0x80);
    } else {
      output.push(current);
      return Buffer.from(output);
    }
  }
}

function tryDecodeVarInt(buffer, start = 0) {
  let result = 0;
  let numRead = 0;

  while (true) {
    const index = start + numRead;
    if (index >= buffer.length) {
      return null;
    }

    const byte = buffer[index];
    result += (byte & 0x7f) * (2 ** (7 * numRead));
    numRead += 1;

    if (numRead > MAX_VARINT_BYTES) {
      throw new ProtocolError("VarInt is too large");
    }

    if ((byte & 0x80) === 0) {
      break;
    }
  }

  if (result >= 0x80000000) {
    result -= 0x100000000;
  }

  return [result, numRead];
}

function decodeVarInt(buffer, start = 0) {
  const decoded = tryDecodeVarInt(buffer, start);
  if (!decoded) {
    throw new ProtocolError("Incomplete VarInt");
  }
  return decoded;
}

function offlineUuid(username) {
  const digest = crypto.createHash("md5").update(`OfflinePlayer:${username}`, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return digest;
}

function encodeNbtString(value) {
  const encoded = Buffer.from(String(value), "utf8");
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(encoded.length, 0);
  return Buffer.concat([prefix, encoded]);
}

function toSignedInt64(value) {
  return BigInt.asIntN(64, BigInt(value));
}

class ByteWriter {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  _push(buffer) {
    this.parts.push(buffer);
    this.length += buffer.length;
  }

  write(raw) {
    this._push(Buffer.from(raw));
  }

  writeBool(value) {
    this._push(Buffer.from([value ? 1 : 0]));
  }

  writeByte(value) {
    const buffer = Buffer.alloc(1);
    buffer.writeInt8(Number(value), 0);
    this._push(buffer);
  }

  writeUnsignedByte(value) {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(Number(value), 0);
    this._push(buffer);
  }

  writeShort(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16BE(Number(value), 0);
    this._push(buffer);
  }

  writeUShort(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(Number(value), 0);
    this._push(buffer);
  }

  writeInt(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(Number(value), 0);
    this._push(buffer);
  }

  writeLong(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(toSignedInt64(value), 0);
    this._push(buffer);
  }

  writeFloat(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatBE(Number(value), 0);
    this._push(buffer);
  }

  writeDouble(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleBE(Number(value), 0);
    this._push(buffer);
  }

  writeUuid(value) {
    const buffer = Buffer.from(value);
    if (buffer.length !== 16) {
      throw new ProtocolError("UUID payload must be 16 bytes");
    }
    this._push(buffer);
  }

  writeVarInt(value) {
    this._push(encodeVarInt(value));
  }

  writeString(value) {
    const encoded = Buffer.from(String(value), "utf8");
    this.writeVarInt(encoded.length);
    this._push(encoded);
  }

  toBuffer() {
    return Buffer.concat(this.parts, this.length);
  }
}

class ByteReader {
  constructor(data) {
    this.data = Buffer.from(data);
    this.index = 0;
  }

  get remaining() {
    return this.data.length - this.index;
  }

  read(size) {
    if (size < 0) {
      throw new ProtocolError("Cannot read a negative number of bytes");
    }
    if (this.remaining < size) {
      throw new ProtocolError(`Need ${size} bytes but only ${this.remaining} remain in the buffer`);
    }
    const start = this.index;
    this.index += size;
    return this.data.subarray(start, this.index);
  }

  skip(size) {
    this.read(size);
  }

  readRemaining() {
    return this.read(this.remaining);
  }

  readBool() {
    return this.readUnsignedByte() !== 0;
  }

  readByte() {
    const value = this.data.readInt8(this.index);
    this.index += 1;
    return value;
  }

  readUnsignedByte() {
    const value = this.data.readUInt8(this.index);
    this.index += 1;
    return value;
  }

  readShort() {
    const value = this.data.readInt16BE(this.index);
    this.index += 2;
    return value;
  }

  readUShort() {
    const value = this.data.readUInt16BE(this.index);
    this.index += 2;
    return value;
  }

  readInt() {
    const value = this.data.readInt32BE(this.index);
    this.index += 4;
    return value;
  }

  readLong() {
    const value = this.data.readBigInt64BE(this.index);
    this.index += 8;
    return value;
  }

  readUnsignedLong() {
    const value = this.data.readBigUInt64BE(this.index);
    this.index += 8;
    return value;
  }

  readFloat() {
    const value = this.data.readFloatBE(this.index);
    this.index += 4;
    return value;
  }

  readDouble() {
    const value = this.data.readDoubleBE(this.index);
    this.index += 8;
    return value;
  }

  readUuid() {
    return this.read(16);
  }

  readVarInt() {
    const [value, consumed] = decodeVarInt(this.data, this.index);
    this.index += consumed;
    return value;
  }

  readString() {
    const length = this.readVarInt();
    if (length < 0) {
      throw new ProtocolError("String length cannot be negative");
    }
    return this.read(length).toString("utf8");
  }
}

class PacketStream {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.error = null;
    this.waiters = [];

    this.socket.on("data", (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
      this._resolveWaiters();
    });

    this.socket.on("error", (error) => {
      this.error = error;
      this._rejectWaiters(error);
    });

    const closeHandler = () => {
      this.closed = true;
      this._rejectWaiters(new ConnectionClosed("The server closed the TCP connection"));
    };

    this.socket.on("close", closeHandler);
    this.socket.on("end", closeHandler);
  }

  _resolveWaiters() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  _rejectWaiters(error) {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  _waitForData(timeoutMs) {
    if (this.error) {
      throw this.error;
    }
    if (this.closed) {
      throw new ConnectionClosed("The server closed the TCP connection");
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      if (timeoutMs != null) {
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new StreamTimeoutError("Timed out while waiting for server data"));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  async _readFrame(timeoutMs) {
    while (true) {
      const decoded = tryDecodeVarInt(this.buffer);
      if (!decoded) {
        await this._waitForData(timeoutMs);
        continue;
      }

      const [packetLength, lengthSize] = decoded;
      if (packetLength < 0) {
        throw new ProtocolError(`Negative packet length ${packetLength}`);
      }

      const totalSize = lengthSize + packetLength;
      while (this.buffer.length < totalSize) {
        await this._waitForData(timeoutMs);
      }

      const frame = this.buffer.subarray(lengthSize, totalSize);
      this.buffer = this.buffer.subarray(totalSize);
      return frame;
    }
  }

  async readPacket(compressionThreshold, timeoutMs) {
    const frame = await this._readFrame(timeoutMs);
    let packetBody;

    if (compressionThreshold >= 0) {
      const frameReader = new ByteReader(frame);
      const dataLength = frameReader.readVarInt();
      const framedPayload = frameReader.readRemaining();

      if (dataLength === 0) {
        packetBody = framedPayload;
      } else {
        try {
          packetBody = zlib.inflateSync(framedPayload);
        } catch (error) {
          throw new ProtocolError(`Failed to decompress packet: ${error.message}`);
        }
        if (packetBody.length !== dataLength) {
          throw new ProtocolError("Decompressed packet size does not match the declared size");
        }
      }
    } else {
      packetBody = frame;
    }

    const bodyReader = new ByteReader(packetBody);
    const packetId = bodyReader.readVarInt();
    const payload = bodyReader.readRemaining();
    return [packetId, payload];
  }

  sendPacket(packetId, payload, compressionThreshold) {
    const packetBody = Buffer.concat([encodeVarInt(packetId), Buffer.from(payload)]);
    let framed;

    if (compressionThreshold >= 0) {
      if (packetBody.length >= compressionThreshold) {
        const compressed = zlib.deflateSync(packetBody);
        framed = Buffer.concat([encodeVarInt(packetBody.length), compressed]);
      } else {
        framed = Buffer.concat([encodeVarInt(0), packetBody]);
      }
    } else {
      framed = packetBody;
    }

    this.socket.write(Buffer.concat([encodeVarInt(framed.length), framed]));
  }
}

function calculateRequiredLongs(entryCount, bitsPerEntry) {
  if (bitsPerEntry <= 0) {
    return 0;
  }

  let longCount = 0;
  let currentBits = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (currentBits + bitsPerEntry > 64) {
      longCount += 1;
      currentBits = 0;
    }
    currentBits += bitsPerEntry;
  }

  return longCount + 1;
}

function skipNbtPayload(reader, tagId) {
  if (tagId === TAG_END) {
    return;
  }
  if (tagId === TAG_BYTE) {
    reader.skip(1);
    return;
  }
  if (tagId === TAG_SHORT) {
    reader.skip(2);
    return;
  }
  if (tagId === TAG_INT || tagId === TAG_FLOAT) {
    reader.skip(4);
    return;
  }
  if (tagId === TAG_LONG || tagId === TAG_DOUBLE) {
    reader.skip(8);
    return;
  }
  if (tagId === TAG_BYTE_ARRAY) {
    reader.skip(reader.readInt());
    return;
  }
  if (tagId === TAG_STRING) {
    reader.skip(reader.readUShort());
    return;
  }
  if (tagId === TAG_LIST) {
    const elementTag = reader.readUnsignedByte();
    const length = reader.readInt();
    for (let index = 0; index < length; index += 1) {
      skipNbtPayload(reader, elementTag);
    }
    return;
  }
  if (tagId === TAG_COMPOUND) {
    skipNbtCompound(reader);
    return;
  }
  if (tagId === TAG_INT_ARRAY) {
    reader.skip(reader.readInt() * 4);
    return;
  }
  if (tagId === TAG_LONG_ARRAY) {
    reader.skip(reader.readInt() * 8);
    return;
  }
  throw new ProtocolError(`Unsupported NBT tag id ${tagId}`);
}

function skipNbtCompound(reader) {
  while (true) {
    const tagId = reader.readUnsignedByte();
    if (tagId === TAG_END) {
      return;
    }
    const nameLength = reader.readUShort();
    reader.skip(nameLength);
    skipNbtPayload(reader, tagId);
  }
}

function skipNbtRoot(reader) {
  const tagId = reader.readUnsignedByte();
  if (tagId === TAG_END) {
    return tagId;
  }

  const nameLength = reader.readUShort();
  reader.skip(nameLength);
  skipNbtPayload(reader, tagId);
  return tagId;
}

function readNbtRoot(reader) {
  const tagId = reader.readUnsignedByte();
  if (tagId === TAG_END) {
    return ["", new NBTValue(TAG_END, null)];
  }

  const nameLength = reader.readUShort();
  const name = reader.read(nameLength).toString("utf8");
  return [name, readNbtPayload(reader, tagId)];
}

function readNbtPayload(reader, tagId) {
  if (tagId === TAG_END) {
    return new NBTValue(TAG_END, null);
  }
  if (tagId === TAG_BYTE) {
    return new NBTValue(TAG_BYTE, reader.readByte());
  }
  if (tagId === TAG_SHORT) {
    return new NBTValue(TAG_SHORT, reader.readShort());
  }
  if (tagId === TAG_INT) {
    return new NBTValue(TAG_INT, reader.readInt());
  }
  if (tagId === TAG_LONG) {
    return new NBTValue(TAG_LONG, reader.readLong());
  }
  if (tagId === TAG_FLOAT) {
    return new NBTValue(TAG_FLOAT, reader.readFloat());
  }
  if (tagId === TAG_DOUBLE) {
    return new NBTValue(TAG_DOUBLE, reader.readDouble());
  }
  if (tagId === TAG_BYTE_ARRAY) {
    return new NBTValue(TAG_BYTE_ARRAY, reader.read(reader.readInt()));
  }
  if (tagId === TAG_STRING) {
    const length = reader.readUShort();
    return new NBTValue(TAG_STRING, reader.read(length).toString("utf8"));
  }
  if (tagId === TAG_LIST) {
    const elementTag = reader.readUnsignedByte();
    const length = reader.readInt();
    return new NBTValue(
      TAG_LIST,
      Array.from({ length }, () => readNbtPayload(reader, elementTag)),
    );
  }
  if (tagId === TAG_COMPOUND) {
    const values = {};
    while (true) {
      const childTag = reader.readUnsignedByte();
      if (childTag === TAG_END) {
        break;
      }
      const nameLength = reader.readUShort();
      const name = reader.read(nameLength).toString("utf8");
      values[name] = readNbtPayload(reader, childTag);
    }
    return new NBTValue(TAG_COMPOUND, values);
  }
  if (tagId === TAG_INT_ARRAY) {
    const length = reader.readInt();
    return new NBTValue(TAG_INT_ARRAY, Array.from({ length }, () => reader.readInt()));
  }
  if (tagId === TAG_LONG_ARRAY) {
    const length = reader.readInt();
    return new NBTValue(TAG_LONG_ARRAY, Array.from({ length }, () => reader.readLong()));
  }
  throw new ProtocolError(`Unsupported NBT tag id ${tagId}`);
}

function encodeNbtPayload(tag) {
  if (tag.tagId === TAG_BYTE) {
    const buffer = Buffer.alloc(1);
    buffer.writeInt8(Number(tag.value), 0);
    return buffer;
  }
  if (tag.tagId === TAG_INT) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(Number(tag.value), 0);
    return buffer;
  }
  if (tag.tagId === TAG_LONG) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(toSignedInt64(tag.value), 0);
    return buffer;
  }
  if (tag.tagId === TAG_STRING) {
    return encodeNbtString(tag.value);
  }
  if (tag.tagId === TAG_COMPOUND) {
    const parts = [];
    for (const [name, child] of Object.entries(tag.value)) {
      parts.push(Buffer.from([child.tagId]));
      parts.push(encodeNbtString(name));
      parts.push(encodeNbtPayload(child));
    }
    parts.push(Buffer.from([TAG_END]));
    return Buffer.concat(parts);
  }
  throw new ProtocolError(`Cannot encode NBT tag id ${tag.tagId}`);
}

function encodeNbtRoot(rootName, rootValue) {
  return Buffer.concat([
    Buffer.from([TAG_COMPOUND]),
    encodeNbtString(rootName),
    encodeNbtPayload(nbtCompound(rootValue)),
  ]);
}

function gzipNbt(rootName, rootValue) {
  return zlib.gzipSync(encodeNbtRoot(rootName, rootValue));
}

module.exports = {
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
  MAX_VARINT_BYTES,
  ProtocolError,
  ConnectionClosed,
  StreamTimeoutError,
  NBTValue,
  nbtByte,
  nbtInt,
  nbtLong,
  nbtString,
  nbtCompound,
  encodeVarInt,
  tryDecodeVarInt,
  decodeVarInt,
  offlineUuid,
  ByteWriter,
  ByteReader,
  PacketStream,
  calculateRequiredLongs,
  skipNbtPayload,
  skipNbtCompound,
  skipNbtRoot,
  readNbtRoot,
  readNbtPayload,
  encodeNbtRoot,
  gzipNbt,
};

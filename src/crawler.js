const EventEmitter = require('events');
const { MinecraftClient } = require('./client');
const convertChunks = require('./convert');
const { createLogger } = require('../shared/logger');

class Crawler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      host: '127.0.0.1',
      port: 25565,
      username: 'Crawler',
      protocol: 772,
      outputDir: 'output',
      worldDir: 'world',
      viewDistance: 127,
      connectTimeout: 10.0,
      readTimeout: 180.0,
      maxCaptureSeconds: 180.0,
      logLevel: 'INFO',
      ...options
    };

    this.logger = createLogger({
      level: this.options.logLevel,
      consoleStyle: 'simple'
    });

    this.client = null;
    this._isRunning = false;
  }

  async start() {
    if (this._isRunning) return;
    this._isRunning = true;

    this.client = new MinecraftClient({
      serverIp: this.options.host,
      serverPort: this.options.port,
      username: this.options.username,
      protocolVersion: this.options.protocol,
      outputRoot: this.options.outputDir,
      worldRoot: this.options.worldDir,
      viewDistance: this.options.viewDistance,
      connectTimeout: this.options.connectTimeout,
      readTimeout: this.options.readTimeout,
      maxCaptureSeconds: this.options.maxCaptureSeconds,
      logger: this.logger,
      eventEmitter: this
    });

    try {
      this.emit('connect');
      await this.client.run();
      this._isRunning = false;
      this.emit('end');
    } catch (error) {
      this._isRunning = false;
      this.emit('error', error);
    }
  }

  stop() {
    if (!this._isRunning) return;
    if (this.client) {
      this.client.close();
    }
    this._isRunning = false;
  }

  convertChunks(options = {}) {
    return convertChunks({
      chunksDir: options.chunksDir || `${this.options.outputDir}/chunks`,
      worldDir: options.worldDir || this.options.worldDir,
      logLevel: options.logLevel || this.options.logLevel,
      host: this.options.host,
      port: this.options.port,
      ...options
    });
  }
}

function createCrawler(options) {
  return new Crawler(options);
}

module.exports = {
  Crawler,
  createCrawler
};

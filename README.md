# RCrawler

A Node.js Minecraft server crawler that connects to offline-mode servers, captures raw chunk data packets, stores them as `.bin` files, and converts them into Anvil (`.mca`) region files. Supports both CLI usage and a programmatic, library-first API.

[![npm version](https://img.shields.io/npm/v/rcrawler.svg)](https://www.npmjs.com/package/rcrawler)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://opensource.org/licenses/GPL-3.0)

---

## Quick Example

Get started in seconds with a minimal crawler:

```javascript
const createCrawler = require('rcrawler');

const bot = createCrawler({
  host: '127.0.0.1',
  username: 'CrawlerBot',
  protocol: 774 // Minecraft 1.21.11
});

bot.on('chunk', (chunk) => {
  console.log(`Captured chunk at [${chunk.x}, ${chunk.z}]`);
});

bot.start();
```

---

## Installation

Install globally for CLI usage or locally for your project:

```bash
# Global installation for CLI
npm install -g rcrawler

# Local installation for library use
npm install rcrawler
```

---

## Programmatic API

The library provides an `EventEmitter` based API similar to `mineflayer`, allowing for granular control over the crawling process.

```javascript
const createCrawler = require('rcrawler');

const bot = createCrawler({
  host: '127.0.0.1',
  port: 25565,
  username: 'ChunkGetter',
  protocol: 774,

  // Storage Settings
  outputDir: 'output', // Where raw .bin chunks go
  worldDir: 'world',   // Where converted .mca files go

  // Behavior Settings
  viewDistance: 64,
  connectTimeout: 10,
  readTimeout: 180,
  maxCaptureSeconds: 300,

  logLevel: 'INFO'
});

// Event Listeners
bot.on('connect', () => console.log('[+] Connected to server'));
bot.on('chunk', (chunk) => console.log(`[+] Received: X=${chunk.x}, Z=${chunk.z}`));
bot.on('error', (err) => console.error('[!] Error:', err.message));

bot.on('end', async () => {
  console.log('[+] Crawl finished. Starting conversion...');

  // Optional: Convert captured data to Anvil format immediately
  await bot.convertChunks();
  
  console.log('[+] World export complete.');
});

// Execute
bot.start();
```

---

## Options

The `createCrawler(options)` function accepts the following configuration:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `host` | `string` | `'127.0.0.1'` | Server IP address |
| `port` | `number` | `25565` | Server port |
| `username` | `string` | `'Crawler'` | Bot username (offline mode) |
| `protocol` | `number` | `774` | Minecraft protocol version |
| `outputDir` | `string` | `'output'` | Path to store raw chunk binary files |
| `worldDir` | `string` | `'world'` | Path to store exported Anvil region files |
| `viewDistance` | `number` | `127` | Simulated render distance |
| `connectTimeout`| `number` | `10.0` | Connection timeout in seconds |
| `readTimeout` | `number` | `180.0` | Socket read timeout in seconds |
| `maxCaptureSeconds`| `number` | `180.0` | Auto-stop after this duration |
| `logLevel` | `string` | `'INFO'` | Console verbosity (DEBUG, INFO, WARN, ERROR) |

---

## Events

The `Crawler` instance emits the following events:

*   **`connect`**: Emitted when the TCP connection is established.
*   **`chunk`**: Emitted every time a chunk packet is successfully parsed and saved. Receives a `chunk` object with `x` and `z` coordinates.
*   **`error`**: Emitted on connection failures or protocol errors.
*   **`end`**: Emitted when the crawler finishes (due to timeout, server disconnect, or manual stop).

---

## CLI Usage

`rcrawler` comes with a powerful command-line interface for manual operations.

### Capture Chunks
Connect to a server and start capturing data:
```bash
rcrawler --crawl --ip 127.0.0.1 --username Getter --protocol 772
```

### Convert Chunks
Convert your binary captures into Anvil (`.mca`) region files:
```bash
rcrawler --convert-chunks --chunks-dir output/chunks --world-dir world
```

### Generate Protocol Assets
If you need to support a new Minecraft version, you can generate the required protocol assets:
```bash
rcrawler --generate-protocol-assets --minecraft-version 1.20.1 --protocol 763
```

---

## Technical Reference

### Supported Protocols
`rcrawler` uses dynamic protocol mapping. Currently tested and supported:

*   **774**: Minecraft 1.21.11
*   **773**: Minecraft 1.21.9 / 1.21.10
*   **772**: Minecraft 1.21.7 / 1.21.8
*   **771**: Minecraft 1.21.6
*   **770**: Minecraft 1.21.5
*   **763**: Minecraft 1.20.1

### Project Structure
*   `src/index.js`: API entry point
*   `src/crawler.js`: Main lifecycle and event management
*   `src/client.js`: Low-level protocol state machine
*   `src/chunk_handler.js`: Packet parsing and storage logic
*   `src/convert.js`: World export implementation
*   `src/anvil.js`: NBT rebuilding and MCA writing

### Capture File Format (`.bin`)
Each chunk is saved in a custom container optimized for speed:
1.  **Magic Header**: `MCCAP001`
2.  **Length Prefix**: Three 32-bit BE integers for metadata and payload sizes.
3.  **JSON Metadata**: Coordinates, timestamp, version info, and heightmaps.
4.  **Payload**: Raw `level_chunk_with_light` packet data.
5.  **Section Data**: Sliced block-state and biome containers.

---

## Limitations

*   **Offline Mode Only**: The client does not currently support Mojang/Microsoft authentication.
*   **Biomes**: Biome IDs are captured, but exported as `minecraft:plains` by default unless a custom biome registry mapping is provided.

---

## Contributing

This is a fully open-source project and anyone is welcome to contribute! Whether it's fixing a bug, adding a new protocol version, or improving documentation, your help is appreciated.

### How to Contribute

1.  **Fork** the repository.
2.  **Clone** your fork:
    ```bash
    git clone https://github.com/rikgdi/RCrawler-JS.git
    ```
3.  **Create a branch** for your changes:
    ```bash
    git checkout -b feature/AmazingFeature
    ```
4.  **Commit** your changes:
    ```bash
    git commit -m 'Add some AmazingFeature'
    ```
5.  **Push** to the branch:
    ```bash
    git push origin feature/AmazingFeature
    ```
6.  **Open a Pull Request** and describe your changes.

---

## License

This project is licensed under the **GPL-3.0 License**. See the [LICENSE](LICENSE) file for details.

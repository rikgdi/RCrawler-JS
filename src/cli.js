#!/usr/bin/env node
const { parseArgs } = require("util");
const createCrawler = require('./index');
const { convertChunks } = require('./index');

const args = process.argv.slice(2);

const showHelp = () => {
  console.log(`
rcrawler - A Node.js Minecraft server crawler that connects to offline-mode servers, captures raw chunk data packets, stores them as .bin files, and converts them into Anvil (.mca) region files when needed.

Usage:
  rcrawler <command> [options]

Commands:
  --crawl                      Connect to a server and capture chunks
  --convert-chunks             Convert captured chunks into Anvil region files
  --generate-protocol-assets   Generate required protocol assets for a specific version
  --help, -h                   Show this help message

Examples:
  1. Crawl a server:
     rcrawler --crawl --ip 127.0.0.1 --port 25565 --username ChunkGetter --protocol 772 \\
       --viewDistance 64 --maxCaptureSeconds 180 --readTimeout 180 --connectTimeout 10

  2. Convert captured chunks:
     rcrawler --convert-chunks --chunks-dir output/chunks --world-dir world

  3. Generate assets:
     rcrawler --generate-protocol-assets --minecraft-version 1.20.1 --protocol 763

Options for --crawl:
  --ip <address>               Server IP address (required)
  --port <number>              Server port (default: 25565)
  --username <name>            Bot username (required)
  --protocol <number>          Protocol version number (e.g. 774)
  --output-dir <path>          Output directory (default: output)
  --world-dir <path>           World directory (default: world)
  --viewDistance <number>      Render distance (default: 127)
  --connectTimeout <number>    Connection timeout in seconds (default: 10.0)
  --readTimeout <number>       Read timeout in seconds (default: 180.0)
  --maxCaptureSeconds <number> Max capture time in seconds (default: 180.0)
  --log-level <level>          Log level (default: INFO)
`);
};

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  showHelp();
  process.exitCode = 0;
} else if (args.includes('--convert-chunks')) {
  const options = parseArgs({
    options: {
      "chunks-dir": { type: "string", default: "output/chunks" },
      "world-dir": { type: "string", default: "world" },
      "blocks-json": { type: "string", default: "" },
      "default-biome": { type: "string", default: "minecraft:plains" },
      "log-level": { type: "string", default: "INFO" },
      ip: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "25565" },
    },
    allowPositionals: true,
    strict: false,
  }).values;
  
  try {
    convertChunks({
      chunksDir: options["chunks-dir"],
      worldDir: options["world-dir"],
      blocksJsonPath: options["blocks-json"],
      defaultBiome: options["default-biome"],
      logLevel: options["log-level"],
      host: options.ip,
      port: Number(options.port),
    });
    process.exitCode = 0;
  } catch (e) {
    process.exitCode = 1;
  }
} else if (args.includes('--generate-protocol-assets')) {
  process.argv = process.argv.filter(a => a !== '--generate-protocol-assets');
  const code = require('./generate_protocol_assets').main();
  if (code instanceof Promise) {
    code.then(c => process.exitCode = c).catch(err => {
      process.stderr.write(`${err.stack || err}\n`);
      process.exitCode = 1;
    });
  } else {
    process.exitCode = code;
  }
} else if (args.includes('--crawl') || args.some(a => a.startsWith('--'))) {
  const options = parseArgs({
    options: {
      ip: { type: "string" },
      port: { type: "string", default: "25565" },
      username: { type: "string" },
      protocol: { type: "string" },
      "output-dir": { type: "string", default: "output" },
      "world-dir": { type: "string", default: "world" },
      "view-distance": { type: "string", default: "127" },
      viewDistance: { type: "string" },
      "connect-timeout": { type: "string", default: "10.0" },
      connectTimeout: { type: "string" },
      "read-timeout": { type: "string", default: "180.0" },
      readTimeout: { type: "string" },
      "max-capture-seconds": { type: "string", default: "180.0" },
      maxCaptureSeconds: { type: "string" },
      "log-level": { type: "string", default: "INFO" },
    },
    allowPositionals: true,
    strict: false
  }).values;

  if (!options.ip || !options.username) {
    console.error("Missing required arguments: --ip and --username");
    process.exitCode = 1;
  } else {
    const crawler = createCrawler({
      host: options.ip,
      port: Number(options.port),
      username: options.username,
      protocol: options.protocol ? Number(options.protocol) : undefined,
      outputDir: options["output-dir"],
      worldDir: options["world-dir"],
      viewDistance: Number(options.viewDistance || options["view-distance"]),
      connectTimeout: Number(options.connectTimeout || options["connect-timeout"]),
      readTimeout: Number(options.readTimeout || options["read-timeout"]),
      maxCaptureSeconds: Number(options.maxCaptureSeconds || options["max-capture-seconds"]),
      logLevel: options["log-level"],
    });

    crawler.on('error', (err) => {
      console.error(err.message || String(err));
      process.exitCode = 1;
    });
    
    crawler.start().catch(err => {
      console.error(err.message || String(err));
      process.exitCode = 1;
    });
  }
} else {
  showHelp();
  process.exitCode = 1;
}

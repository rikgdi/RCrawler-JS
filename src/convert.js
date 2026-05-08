const path = require("path");
const fs = require("fs");
const os = require("os");
const Zip = require("adm-zip");
const { WorldExporter } = require("./anvil");
const { createLogger } = require("./logger");

const TEMPLATE_LEVEL_DAT = path.join(__dirname, "assets", "templates", "level.dat");

function convertChunks(options = {}) {
  const {
    chunksDir = "output/chunks",
    worldDir = "world",
    blocksJsonPath = null,
    defaultBiome = "minecraft:plains",
    logLevel = "INFO",
    host = "127.0.0.1",
    port = 25565,
    keepWorldFolder = false,
  } = options;

  const logger = createLogger({
    level: logLevel,
    consoleStyle: "simple",
  });
  const resolvedChunksDir = path.resolve(chunksDir);

  // Use a temporary directory for conversion to keep user workspace clean
  const tempWorldDir = fs.mkdtempSync(path.join(os.tmpdir(), "rcrawler-"));
  const finalWorldDir = path.resolve(worldDir);

  const exporter = new WorldExporter({
    chunksDir: resolvedChunksDir,
    worldDir: tempWorldDir,
    blocksJsonPath: blocksJsonPath ? path.resolve(blocksJsonPath) : null,
    defaultBiome,
    logger,
  });

  try {
    const chunkCount = countCaptureFiles(resolvedChunksDir);
    const regions = exporter.export();
    logger.info("Converted %d chunk(s) into %d region file(s)", chunkCount, regions.length);

    const zipFileName = zipWorld({
      host,
      port,
      tempWorldDir,
      userWorldDir: finalWorldDir, // Still used as lookup path for level.dat if provided
      logger,
    });

    if (keepWorldFolder) {
      fs.mkdirSync(finalWorldDir, { recursive: true });
      const finalRegionDir = path.join(finalWorldDir, "region");
      if (fs.existsSync(finalRegionDir)) {
        fs.rmSync(finalRegionDir, { recursive: true, force: true });
      }
      fs.renameSync(path.join(tempWorldDir, "region"), finalRegionDir);
      logger.info("World folder contents preserved at: %s", finalWorldDir);
    }

    // Cleanup temp directory
    fs.rmSync(tempWorldDir, { recursive: true, force: true });

    return {
      regions,
      zipFile: zipFileName, // Now stays in root
    };
  } catch (error) {
    // Ensure cleanup even on error
    if (fs.existsSync(tempWorldDir)) {
      fs.rmSync(tempWorldDir, { recursive: true, force: true });
    }
    logger.error("%s", error.message || String(error));
    throw error;
  }
}

function countCaptureFiles(chunksDir) {
  if (!fs.existsSync(chunksDir)) {
    return 0;
  }
  return fs.readdirSync(chunksDir).filter((name) => /^chunk_.*\.bin$/.test(name)).length;
}

function zipWorld({ host, port, tempWorldDir, userWorldDir, logger }) {
  const zip = new Zip();
  const timestamp = Math.floor(Date.now() / 1000);
  const safeHost = String(host).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const folderName = `${safeHost}_${port}`;
  const zipFileName = `${folderName}-${timestamp}.zip`;

  // 1. Add level.dat (Priority: User provided in worldDir > Template in assets)
  const userLevelDat = path.join(userWorldDir, "level.dat");
  if (fs.existsSync(userLevelDat)) {
    zip.addLocalFile(userLevelDat, folderName);
    logger.info("Using provided level.dat from %s", userWorldDir);
  } else if (fs.existsSync(TEMPLATE_LEVEL_DAT)) {
    zip.addLocalFile(TEMPLATE_LEVEL_DAT, folderName);
    logger.info("Using default level.dat template");
  } else {
    logger.warn("No level.dat found (user or template); world may not be loadable");
  }

  // 2. Add region folder from the temporary conversion directory
  const regionDir = path.join(tempWorldDir, "region");
  if (fs.existsSync(regionDir)) {
    zip.addLocalFolder(regionDir, path.join(folderName, "region"));
  }

  zip.writeZip(zipFileName);
  logger.info("Created world ZIP: %s", zipFileName);
  return zipFileName;
}

module.exports = convertChunks;

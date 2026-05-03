const path = require("path");
const fs = require("fs");
const os = require("os");
const Zip = require("adm-zip");
const { WorldExporter } = require("./anvil");
const { createLogger } = require("../shared/logger");

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

  // Use a temporary directory for conversion to keep user workspace clean
  const tempWorldDir = fs.mkdtempSync(path.join(os.tmpdir(), "rcrawler-"));
  const finalWorldDir = path.resolve(worldDir);

  const exporter = new WorldExporter({
    chunksDir: path.resolve(chunksDir),
    worldDir: tempWorldDir,
    blocksJsonPath: blocksJsonPath ? path.resolve(blocksJsonPath) : null,
    defaultBiome,
    logger,
  });

  try {
    const regions = exporter.export();
    logger.info("Converted %d chunk(s) into %d region file(s)", regions.length > 0 ? 1 : 0, regions.length);

    const zipFileName = zipWorld({
      host,
      port,
      tempWorldDir,
      userWorldDir: finalWorldDir,
      logger,
    });

    if (keepWorldFolder) {
      // If user wants to keep the folder, move it from temp to final destination
      if (fs.existsSync(finalWorldDir)) {
        fs.rmSync(finalWorldDir, { recursive: true, force: true });
      }
      fs.renameSync(tempWorldDir, finalWorldDir);
      logger.info("World folder preserved at: %s", finalWorldDir);
    } else {
      // Cleanup temp directory
      fs.rmSync(tempWorldDir, { recursive: true, force: true });
    }

    return {
      regions,
      zipFile: zipFileName,
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

function zipWorld({ host, port, tempWorldDir, userWorldDir, logger }) {
  const zip = new Zip();
  const timestamp = Math.floor(Date.now() / 1000);
  const safeHost = host.replace(/[:]/g, "_");
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

const path = require("path");
const fs = require("fs");
const Zip = require("adm-zip");
const { WorldExporter } = require("./anvil");
const { createLogger } = require("../shared/logger");

function convertChunks(options = {}) {
  const {
    chunksDir = "output/chunks",
    worldDir = "world",
    blocksJsonPath = null,
    defaultBiome = "minecraft:plains",
    logLevel = "INFO",
    host = "127.0.0.1",
    port = 25565,
  } = options;

  const logger = createLogger({
    level: logLevel,
    consoleStyle: "simple",
  });

  const exporter = new WorldExporter({
    chunksDir: path.resolve(chunksDir),
    worldDir: path.resolve(worldDir),
    blocksJsonPath: blocksJsonPath ? path.resolve(blocksJsonPath) : null,
    defaultBiome,
    logger,
  });

  try {
    const regions = exporter.export();
    logger.info("Wrote %s region file(s)", regions.length);

    const zipFileName = zipWorld({
      host,
      port,
      worldDir: path.resolve(worldDir),
      logger,
    });

    return {
      regions,
      zipFile: zipFileName,
    };
  } catch (error) {
    logger.error("%s", error.message || String(error));
    throw error;
  }
}

function zipWorld({ host, port, worldDir, logger }) {
  const zip = new Zip();
  const timestamp = Math.floor(Date.now() / 1000);
  const safeHost = host.replace(/[:]/g, "_");
  const folderName = `${safeHost}_${port}`;
  const zipFileName = `${folderName}-${timestamp}.zip`;

  // Add level.dat
  const levelDatPath = path.join(worldDir, "level.dat");
  if (fs.existsSync(levelDatPath)) {
    zip.addLocalFile(levelDatPath, folderName);
  } else {
    logger.warn("level.dat not found in %s, ZIP will be incomplete", worldDir);
  }

  // Add region folder
  const regionDir = path.join(worldDir, "region");
  if (fs.existsSync(regionDir)) {
    zip.addLocalFolder(regionDir, path.join(folderName, "region"));
  } else {
    logger.warn("region folder not found in %s", worldDir);
  }

  zip.writeZip(zipFileName);
  logger.info("Created world ZIP: %s", zipFileName);
  return zipFileName;
}

module.exports = convertChunks;

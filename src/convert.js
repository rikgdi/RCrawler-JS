const path = require("path");
const { WorldExporter } = require("./anvil");
const { createLogger } = require("../shared/logger");

function convertChunks(options = {}) {
  const {
    chunksDir = "output/chunks",
    worldDir = "world",
    blocksJsonPath = null,
    defaultBiome = "minecraft:plains",
    logLevel = "INFO",
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
    return regions;
  } catch (error) {
    logger.error("%s", error.message || String(error));
    throw error;
  }
}

module.exports = convertChunks;

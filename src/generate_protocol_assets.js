#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");
const { spawnSync } = require("child_process");

const AdmZip = require("adm-zip");

const VERSION_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const DATA_PATHS_URL = "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/dataPaths.json";
const PRISMARINE_RAW_ROOT = "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data";
const METADATA_FILE_NAME = "metadata.json";

const STATE_NAME_MAP = {
  handshaking: "handshake",
  login: "login",
  configuration: "configuration",
  play: "play",
};

const DIRECTION_NAME_MAP = {
  toClient: "clientbound",
  toServer: "serverbound",
};

const PACKET_NAME_ALIASES = {
  "handshaking|toServer|set_protocol": "intention",
  "login|toClient|disconnect": "login_disconnect",
  "login|toClient|encryption_begin": "hello",
  "login|toClient|success": "login_finished",
  "login|toClient|compress": "login_compression",
  "login|toClient|login_plugin_request": "custom_query",
  "login|toServer|login_start": "hello",
  "login|toServer|encryption_begin": "key",
  "login|toServer|login_plugin_response": "custom_query_answer",
  "configuration|toClient|add_resource_pack": "resource_pack_push",
  "configuration|toClient|resource_pack_send": "resource_pack_push",
  "configuration|toClient|remove_resource_pack": "resource_pack_pop",
  "configuration|toClient|feature_flags": "update_enabled_features",
  "configuration|toClient|tags": "update_tags",
  "configuration|toServer|settings": "client_information",
  "configuration|toServer|resource_pack_receive": "resource_pack",
  "play|toClient|position": "player_position",
  "play|toClient|map_chunk": "level_chunk_with_light",
  "play|toClient|update_view_position": "set_chunk_cache_center",
  "play|toClient|add_resource_pack": "resource_pack_push",
  "play|toClient|remove_resource_pack": "resource_pack_pop",
  "play|toClient|resource_pack_send": "resource_pack_push",
  "play|toClient|kick_disconnect": "disconnect",
  "play|toServer|teleport_confirm": "accept_teleportation",
  "play|toServer|settings": "client_information",
  "play|toServer|resource_pack_receive": "resource_pack",
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function downloadFile(url, destination, { sha1 = null } = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination) && sha1) {
    const digest = crypto.createHash("sha1").update(fs.readFileSync(destination)).digest("hex");
    if (digest === sha1) {
      return;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);

  if (sha1) {
    const digest = crypto.createHash("sha1").update(fs.readFileSync(destination)).digest("hex");
    if (digest !== sha1) {
      throw new Error(`Downloaded file checksum mismatch for ${destination}: expected ${sha1}, got ${digest}`);
    }
  }
}

async function fetchVersionMetadata(minecraftVersion) {
  const manifest = await fetchJson(VERSION_MANIFEST_URL);
  const entry = manifest.versions.find((version) => version.id === minecraftVersion);
  if (!entry) {
    throw new Error(`Minecraft version ${minecraftVersion} was not found in Mojang's manifest`);
  }
  return fetchJson(entry.url);
}

function readDataVersion(serverJar) {
  const zip = new AdmZip(serverJar);
  const entry = zip.getEntry("version.json");
  if (!entry) {
    throw new Error(`version.json was not found in ${serverJar}`);
  }
  const versionJson = JSON.parse(entry.getData().toString("utf8"));
  return Number(versionJson.world_version);
}

function runDataGenerator(serverJar, outputDir, workDir, { javaBin = "java" } = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const result = spawnSync(
    javaBin,
    [
      "-DbundlerMainClass=net.minecraft.data.Main",
      "-jar",
      path.resolve(serverJar),
      "--reports",
      "--output",
      path.resolve(outputDir),
    ],
    {
      cwd: workDir,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    throw new Error(`Minecraft data generator exited with status ${result.status}`);
  }
}

function packetMapping(protocolSection) {
  const packetType = protocolSection.types.packet;
  const mappings = packetType[1][0].type[1].mappings;
  return Object.fromEntries(
    Object.entries(mappings).map(([packetId, name]) => [name, Number.parseInt(packetId, 16)]),
  );
}

function buildPacketsJsonFromReport(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const packets = {};

  for (const [state, directions] of Object.entries(report)) {
    packets[state] = {};
    for (const [direction, values] of Object.entries(directions)) {
      packets[state][direction] = {};
      for (const [packetNameValue, metadata] of Object.entries(values)) {
        const protocolId = metadata && typeof metadata === "object"
          ? Number(metadata.protocol_id)
          : Number(metadata);
        packets[state][direction][packetNameValue] = { protocol_id: protocolId };
      }
    }
  }

  return packets;
}

async function buildPacketsJson(minecraftVersion, { reportPath = null } = {}) {
  const dataPaths = await fetchJson(DATA_PATHS_URL);
  const versionPaths = (((dataPaths || {}).pc || {})[minecraftVersion]);

  if (!versionPaths) {
    if (!reportPath || !fs.existsSync(reportPath)) {
      throw new Error(
        `minecraft-data has no protocol entry for ${minecraftVersion}, and no Mojang packet report was available at ${reportPath}.`,
      );
    }
    return buildPacketsJsonFromReport(reportPath);
  }

  const protocolPath = versionPaths.protocol;
  const protocol = await fetchJson(`${PRISMARINE_RAW_ROOT}/${protocolPath}/protocol.json`);
  const packets = {};

  for (const [sourceState, targetState] of Object.entries(STATE_NAME_MAP)) {
    if (!protocol[sourceState]) {
      continue;
    }
    packets[targetState] = {};
    for (const [sourceDirection, targetDirection] of Object.entries(DIRECTION_NAME_MAP)) {
      if (!protocol[sourceState][sourceDirection]) {
        continue;
      }

      const normalized = {};
      for (const [sourceName, packetId] of Object.entries(packetMapping(protocol[sourceState][sourceDirection]))) {
        const aliasKey = `${sourceState}|${sourceDirection}|${sourceName}`;
        const normalizedName = PACKET_NAME_ALIASES[aliasKey] || sourceName;
        normalized[`minecraft:${normalizedName}`] = { protocol_id: packetId };
      }
      packets[targetState][targetDirection] = normalized;
    }
  }

  return packets;
}

async function generateAssets({
  minecraftVersion,
  protocolVersion,
  assetsRoot,
  workDir,
  javaBin = "java",
}) {
  const metadata = await fetchVersionMetadata(minecraftVersion);
  const serverDownload = metadata.downloads.server;
  const serverJar = path.join(workDir, `server-${minecraftVersion}.jar`);
  const generatedDir = path.join(workDir, "generated");
  const reportsDir = path.join(generatedDir, "reports");
  const assetsDir = path.join(assetsRoot, String(protocolVersion));

  await downloadFile(serverDownload.url, serverJar, { sha1: serverDownload.sha1 || null });
  runDataGenerator(serverJar, generatedDir, workDir, { javaBin });

  fs.mkdirSync(assetsDir, { recursive: true });
  fs.copyFileSync(path.join(reportsDir, "blocks.json"), path.join(assetsDir, "blocks.json"));
  fs.copyFileSync(path.join(reportsDir, "registries.json"), path.join(assetsDir, "registries.json"));
  fs.writeFileSync(
    path.join(assetsDir, "packets.json"),
    JSON.stringify(await buildPacketsJson(minecraftVersion, { reportPath: path.join(reportsDir, "packets.json") }), null, 2),
    "utf8",
  );

  const dataVersion = readDataVersion(serverJar);
  fs.writeFileSync(
    path.join(assetsDir, METADATA_FILE_NAME),
    JSON.stringify({
      protocol_version: protocolVersion,
      minecraft_version: minecraftVersion,
      data_version: dataVersion,
    }, null, 2),
    "utf8",
  );

  return [assetsDir, dataVersion];
}

function buildOptions() {
  return parseArgs({
    options: {
      "minecraft-version": { type: "string" },
      protocol: { type: "string" },
      "protocol-version": { type: "string" },
      "assets-root": { type: "string", default: path.join(__dirname, "assets") },
      "work-dir": { type: "string", default: "" },
      "java-bin": { type: "string", default: process.env.MC_JAVA_BIN || "java" },
    },
    allowPositionals: false,
  }).values;
}

async function main() {
  const args = buildOptions();
  const minecraftVersion = args["minecraft-version"];
  const protocolVersion = Number(args.protocol || args["protocol-version"]);

  if (!minecraftVersion || !protocolVersion) {
    process.stderr.write("Missing required arguments: --minecraft-version and --protocol\n");
    return 1;
  }

  const repoRoot = __dirname;
  const assetsRoot = path.resolve(args["assets-root"]);
  const workDir = args["work-dir"]
    ? path.resolve(args["work-dir"])
    : path.join(repoRoot, ".tmp", `mc-${minecraftVersion}`);

  try {
    const [assetsDir, dataVersion] = await generateAssets({
      minecraftVersion,
      protocolVersion,
      assetsRoot,
      workDir,
      javaBin: args["java-bin"],
    });
    process.stdout.write(`Generated assets in ${assetsDir}\n`);
    process.stdout.write(`DataVersion: ${dataVersion}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message || String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchJson,
  downloadFile,
  fetchVersionMetadata,
  readDataVersion,
  runDataGenerator,
  packetMapping,
  buildPacketsJsonFromReport,
  buildPacketsJson,
  generateAssets,
  main,
};

const fs = require("fs");
const path = require("path");
const util = require("util");

const LEVELS = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
};

function pad(value, length) {
  return String(value).padStart(length, "0");
}

function formatDateTime(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1, 2),
    pad(date.getDate(), 2),
  ].join("-") + " " + [
    pad(date.getHours(), 2),
    pad(date.getMinutes(), 2),
    pad(date.getSeconds(), 2),
  ].join(":");
}

function formatTime(date) {
  return [
    pad(date.getHours(), 2),
    pad(date.getMinutes(), 2),
    pad(date.getSeconds(), 2),
  ].join(":");
}

function normalizeLevel(level) {
  const key = String(level || "INFO").toUpperCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, key) ? key : "INFO";
}

function formatSimple(level, _name, message) {
  return `[${level}] ${message}`;
}

function formatController(level, name, message) {
  const date = new Date();
  return `${formatDateTime(date)} [${level}]${name ? ` [${name}]` : ""} ${message}`;
}

function formatRenderConsole(level, name, message) {
  const date = new Date();
  return `${formatTime(date)} | ${level.padEnd(7, " ")} | ${(name || "main").padEnd(22, " ")} | ${message}`;
}

function formatRenderFile(level, name, message) {
  const date = new Date();
  return `${formatDateTime(date)} | ${level.padEnd(7, " ")} | ${(name || "main").padEnd(22, " ")} | ${message}`;
}

function formatterFor(style) {
  if (typeof style === "function") {
    return style;
  }

  switch (style) {
    case "controller":
      return formatController;
    case "render-console":
      return formatRenderConsole;
    case "render-file":
      return formatRenderFile;
    case "simple":
    default:
      return formatSimple;
  }
}

function createLogger(options = {}) {
  const consoleThreshold = LEVELS[normalizeLevel(options.consoleLevel || options.level)];
  const fileThreshold = LEVELS[normalizeLevel(options.fileLevel || options.level)];
  const consoleFormatter = formatterFor(options.consoleStyle || "simple");
  const fileFormatter = formatterFor(options.fileStyle || "render-file");
  const filePath = options.filePath ? path.resolve(options.filePath) : null;

  let fileStream = null;
  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fileStream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  }

  function emit(level, name, args) {
    const message = util.format(...args);
    if (LEVELS[level] >= consoleThreshold) {
      const consoleLine = consoleFormatter(level, name, message);
      const stream = level === "ERROR" ? process.stderr : process.stdout;
      stream.write(consoleLine + "\n");
    }

    if (fileStream && LEVELS[level] >= fileThreshold) {
      const fileLine = fileFormatter(level, name, message);
      fileStream.write(fileLine + "\n");
    }
  }

  function buildLogger(name) {
    return {
      child(childName) {
        const next = [name, childName].filter(Boolean).join(".");
        return buildLogger(next);
      },
      debug(...args) {
        emit("DEBUG", name, args);
      },
      info(...args) {
        emit("INFO", name, args);
      },
      warning(...args) {
        emit("WARNING", name, args);
      },
      warn(...args) {
        emit("WARNING", name, args);
      },
      error(...args) {
        emit("ERROR", name, args);
      },
      close() {
        if (fileStream) {
          fileStream.end();
        }
      },
    };
  }

  return buildLogger(options.name || "");
}

module.exports = {
  LEVELS,
  createLogger,
  normalizeLevel,
};

"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { parseArgs } = require("node:util");

const pkg = require("../package.json");

const AUDIO_PRESETS = new Set(["off", "low", "balanced", "high", "max"]);
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

const COMMANDS = new Set([
  "list",
  "add",
  "update",
  "reload",
  "start",
  "stop",
  "close",
  "apply",
  "quit",
  "activate",
]);

const ALIASES = {
  ls: "list",
  status: "list",
  rm: "close",
  remove: "close",
  "start-ndi": "start",
  "stop-ndi": "stop",
  shutdown: "quit",
};

const OPTIONS = {
  url: { type: "string" },
  name: { type: "string" },
  width: { type: "string" },
  height: { type: "string" },
  title: { type: "string" },
  fps: { type: "string" },
  audio: { type: "string" },
  config: { type: "string" },
  transparent: { type: "boolean" },
  frameless: { type: "boolean" },
  hidden: { type: "boolean" },
  ndi: { type: "boolean" },
  merge: { type: "boolean" },
  all: { type: "boolean" },
  json: { type: "boolean" },
  headless: { type: "boolean" },
  panel: { type: "boolean" },
  "user-data-dir": { type: "string" },
  help: { type: "boolean" },
  version: { type: "boolean" },
};

function getArgv(argv, isPackaged) {
  let args = argv.slice(isPackaged ? 1 : 2);
  while (args[0] === "--") args = args.slice(1);
  return args;
}

function parseCli(args) {
  const parsed = parseArgs({
    args,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });

  const positionals = parsed.positionals.slice();
  const rawCommand = positionals.length > 0 ? positionals[0].toLowerCase() : "";
  const command = rawCommand ? ALIASES[rawCommand] || rawCommand : null;

  if (command && !COMMANDS.has(command)) {
    throw new Error(`Unknown command "${rawCommand}"`);
  }

  return {
    command,
    positionals,
    options: parsed.values,
  };
}

function usage() {
  return `Grandicast ${pkg.version}

Usage:
  grandicast [command] [options]

Commands:
  list                       List running windows (alias: ls)
  add [options]              Create and optionally start a window
  update <id|name> [options] Update a running window
  reload <id|name>           Reload a window's page
  start <id|name> [options]  Start NDI output (alias: start-ndi)
  stop <id|name> [--all]     Stop NDI output (alias: stop-ndi)
  close <id|name> [--all]    Close a window (alias: rm, remove)
  apply --config <file|->    Apply a JSON config (replaces by default)
  quit                       Quit Grandicast (alias: shutdown)

Options:
  --url <url>                Page URL
  --name <name>              NDI source name
  --width <px>               Window width (default: 1280)
  --height <px>              Window height (default: 720)
  --title <text>             Window title
  --fps <n>                  NDI frame rate (default: 30)
  --audio <preset>           off | low | balanced | high | max
  --ndi                      Start NDI when adding a window or applying config
  --transparent              Transparent window background
  --frameless                Frameless window
  --hidden                   Hidden window (NDI only)
  --config <file|->          JSON config file ("-" reads stdin)
  --merge                    With apply, add instead of replacing
  --all                      With stop/close, affect all windows
  --json                     Print machine-readable JSON
  --headless                 Run without the control panel
  --panel                    Show the panel when launching with config/url
  --user-data-dir <dir>      Use a custom profile directory
  --help                     Show this help
  --version                  Show the version

JSON config:
  {
    "windows": [
      {
        "url": "https://example.com",
        "width": 1280,
        "height": 720,
        "hidden": false,
        "transparent": false,
        "frameless": false,
        "ndi": {
          "enabled": true,
          "name": "My Source",
          "fps": 30,
          "audio": "balanced"
        }
      }
    ]
  }

  A bare array of window objects is also accepted. "ndi" may be true/false.
  Launching with --config starts headless unless --panel is also passed.`;
}

function positiveInt(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function audioPreset(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value ? "balanced" : "off";
  const normalized = String(value).toLowerCase();
  if (!AUDIO_PRESETS.has(normalized)) {
    throw new Error(`audio must be one of: ${[...AUDIO_PRESETS].join(", ")}`);
  }
  return normalized;
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeWindowConfig(input) {
  const src = input && typeof input === "object" ? input : {};
  const url = text(src.url).trim();
  if (!url) throw new Error('Window config requires a non-empty "url"');

  const ndiRaw = src.ndi;
  const ndiObject =
    ndiRaw && typeof ndiRaw === "object" ? ndiRaw : null;
  const ndiEnabled =
    ndiObject !== null
      ? ndiObject.enabled !== false
      : typeof ndiRaw === "boolean"
        ? ndiRaw
        : false;

  const ndiName = text(
    ndiObject && ndiObject.name !== undefined
      ? ndiObject.name
      : src.name !== undefined
        ? src.name
        : src.ndiName,
  ).trim();
  const fps = positiveInt(
    ndiObject && ndiObject.fps !== undefined ? ndiObject.fps : src.fps,
    30,
    "fps",
  );
  const audio = audioPreset(
    ndiObject && ndiObject.audio !== undefined
      ? ndiObject.audio
      : src.audio !== undefined
        ? src.audio
        : src.audioPreset !== undefined
          ? src.audioPreset
          : src.audioEnabled,
    ndiEnabled ? "balanced" : "off",
  );

  return {
    url,
    width: positiveInt(src.width, 1280, "width"),
    height: positiveInt(src.height, 720, "height"),
    transparent: !!src.transparent,
    frameless: !!src.frameless,
    hidden: !!src.hidden,
    title: text(src.title).trim(),
    ndi: {
      enabled: ndiEnabled,
      name: ndiName,
      fps,
      audio,
    },
  };
}

function normalizeConfig(data) {
  let windows;
  if (Array.isArray(data)) {
    windows = data;
  } else if (data && Array.isArray(data.windows)) {
    windows = data.windows;
  } else if (data && Array.isArray(data.panels)) {
    windows = data.panels;
  } else {
    throw new Error('Config must be an array or an object with a "windows" array');
  }
  return windows.map(normalizeWindowConfig);
}

function loadConfig(spec, cwd) {
  if (!spec) throw new Error("Missing config file");
  let raw;
  let source;
  try {
    if (spec === "-") {
      raw = fs.readFileSync(0, "utf8");
      source = "stdin";
    } else {
      const file = path.resolve(cwd, spec);
      raw = fs.readFileSync(file, "utf8");
      source = file;
    }
  } catch (e) {
    throw new Error(`Failed to read config ${spec}: ${e.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${source}: ${e.message}`);
  }

  return normalizeConfig(parsed);
}

function windowFromOptions(options) {
  const url = text(options.url).trim();
  if (!url) throw new Error("add requires --url <url>");

  const window = {
    url,
    width: positiveInt(options.width, 1280, "width"),
    height: positiveInt(options.height, 720, "height"),
    transparent: !!options.transparent,
    frameless: !!options.frameless,
    hidden: !!options.hidden,
    title: text(options.title).trim(),
    ndi: undefined,
  };

  if (options.name !== undefined) window.name = options.name;
  if (options.fps !== undefined) {
    window.fps = positiveInt(options.fps, 30, "fps");
  }
  if (options.audio !== undefined) {
    window.audio = audioPreset(options.audio, "off");
  }

  if (options.ndi) {
    window.ndi = {
      enabled: true,
      name: text(options.name).trim(),
      fps: positiveInt(options.fps, 30, "fps"),
      audio: audioPreset(options.audio, "balanced"),
    };
  }

  return normalizeWindowConfig(window);
}

function ndiOptions(options) {
  const out = {};
  if (options.name !== undefined) out.ndiName = options.name;
  if (options.fps !== undefined) {
    out.fps = positiveInt(options.fps, 30, "fps");
  }
  if (options.audio !== undefined) {
    out.audioPreset = audioPreset(options.audio, "off");
  }
  return out;
}

function patchFromOptions(options) {
  const patch = {};
  if (options.url !== undefined) patch.url = text(options.url).trim();
  if (options.width !== undefined) {
    patch.width = positiveInt(options.width, 1280, "width");
  }
  if (options.height !== undefined) {
    patch.height = positiveInt(options.height, 720, "height");
  }
  if (options.title !== undefined) patch.title = text(options.title).trim();
  if (options.name !== undefined) patch.ndiName = text(options.name).trim();
  if (options.fps !== undefined) patch.fps = positiveInt(options.fps, 30, "fps");
  if (options.audio !== undefined) {
    patch.audioPreset = audioPreset(options.audio, "off");
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("update requires at least one option");
  }
  return patch;
}

function requireTarget(parsed) {
  const target = parsed.positionals[1];
  if (!target) throw new Error(`${parsed.command} requires a window id or name`);
  return target;
}

function withNdiFlag(windows, options) {
  if (!options.ndi) return windows;
  return windows.map((w) => ({
    ...w,
    ndi: { ...w.ndi, enabled: true },
  }));
}

function buildRequest(parsed, cwd) {
  const options = parsed.options;

  if (!parsed.command) {
    if (options.config) {
      return {
        command: "apply",
        windows: withNdiFlag(loadConfig(options.config, cwd), options),
        merge: !!options.merge,
      };
    }
    if (options.url) {
      return { command: "add", window: windowFromOptions(options) };
    }
    return { command: "activate" };
  }

  switch (parsed.command) {
    case "list":
      return { command: "list" };
    case "add":
      return { command: "add", window: windowFromOptions(options) };
    case "apply":
      if (!options.config) {
        throw new Error("apply requires --config <file|->");
      }
      return {
        command: "apply",
        windows: withNdiFlag(loadConfig(options.config, cwd), options),
        merge: !!options.merge,
      };
    case "update":
      return {
        command: "update",
        target: requireTarget(parsed),
        patch: patchFromOptions(options),
      };
    case "reload":
      return { command: "reload", target: requireTarget(parsed) };
    case "start":
      return {
        command: "start",
        target: requireTarget(parsed),
        options: ndiOptions(options),
      };
    case "stop":
      return {
        command: "stop",
        target: options.all ? null : requireTarget(parsed),
        all: !!options.all,
      };
    case "close":
      return {
        command: "close",
        target: options.all ? null : requireTarget(parsed),
        all: !!options.all,
      };
    case "quit":
      return { command: "quit" };
    default:
      throw new Error(`Unknown command "${parsed.command}"`);
  }
}

function getSocketPath(userDataPath) {
  const id = crypto
    .createHash("sha1")
    .update(userDataPath)
    .digest("hex")
    .slice(0, 10);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\grandicast-${id}`;
  }

  const preferred = path.join(userDataPath, `grandicast-${id}.sock`);
  if (Buffer.byteLength(preferred) <= 100) return preferred;

  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const shortDir = path.join("/tmp", `grandicast-${uid}-${id}`);
  fs.mkdirSync(shortDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(shortDir, 0o700);
  } catch {}
  return path.join(shortDir, "control.sock");
}

function startControlServer(socketPath, handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";

      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_REQUEST_BYTES) {
          socket.destroy();
          return;
        }

        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;

          let request;
          try {
            request = JSON.parse(line);
          } catch {
            socket.write(
              JSON.stringify({ ok: false, error: "Invalid JSON request" }) +
                "\n",
            );
            continue;
          }

          Promise.resolve()
            .then(() => handler(request))
            .then((data) => {
              if (!socket.destroyed) {
                socket.write(JSON.stringify({ ok: true, data }) + "\n");
              }
            })
            .catch((err) => {
              if (!socket.destroyed) {
                socket.write(
                  JSON.stringify({
                    ok: false,
                    error: err && err.message ? err.message : String(err),
                  }) + "\n",
                );
              }
            });
        }
      });

      socket.on("error", () => {});
    });

    if (process.platform !== "win32") {
      try {
        fs.rmSync(socketPath, { force: true });
      } catch {}
    }

    const onListenError = (err) => reject(err);
    server.once("error", onListenError);
    server.listen(socketPath, () => {
      server.removeListener("error", onListenError);
      server.on("error", (err) => {
        console.error("[CLI] Control socket error:", err.message);
      });
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch {}
      }
      resolve({
        server,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              if (process.platform !== "win32") {
                try {
                  fs.rmSync(socketPath, { force: true });
                } catch {}
              }
              done();
            });
          }),
      });
    });
  });
}

function sendRequestOnce(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let buffer = "";

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for Grandicast")),
      15000,
    );

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(new Error("Invalid response from Grandicast"));
      }
    });
    socket.on("error", (err) => finish(err));
    socket.on("close", () => {
      if (!settled) finish(new Error("Connection closed before response"));
    });
  });
}

async function sendRequest(socketPath, request, { retries = 20, delay = 100 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sendRequestOnce(socketPath, request);
    } catch (err) {
      const retryable =
        err.code === "ENOENT" ||
        err.code === "ECONNREFUSED" ||
        err.code === "EAGAIN" ||
        err.code === "ECONNRESET";
      if (!retryable || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function formatList(windows) {
  if (windows.length === 0) return "No windows.\n";
  const rows = windows.map((w) => [
    String(w.id),
    w.ndiActive ? "ndi" : "running",
    w.ndiName || "-",
    `${w.width}x${w.height}`,
    w.url,
  ]);
  const headers = ["ID", "STATE", "NDI NAME", "SIZE", "URL"];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)].join("\n") + "\n";
}

function printResult(request, parsed, data, out) {
  if (parsed.options.json) {
    out.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  switch (request.command) {
    case "activate":
      break;
    case "list":
      out.write(formatList((data && data.windows) || []));
      break;
    case "add": {
      const w = data && data.windows && data.windows[0];
      out.write(`Created window ${w.id} (${w.url})\n`);
      if (w.ndiActive) {
        out.write(
          `NDI started as "${w.ndiName}" at ${w.fps} fps (audio: ${w.audioPreset}).\n`,
        );
      }
      break;
    }
    case "apply": {
      const windows = (data && data.windows) || [];
      out.write(`Applied config: ${windows.length} window(s).\n`);
      out.write(formatList(windows));
      break;
    }
    case "start":
      out.write(
        `NDI started for window ${data.id} as "${data.ndiName}" at ${data.fps} fps (audio: ${data.audioPreset}).\n`,
      );
      break;
    case "stop":
      if (data.ids) {
        out.write(
          data.ids.length
            ? `Stopped NDI for windows: ${data.ids.join(", ")}.\n`
            : "No active NDI outputs.\n",
        );
      } else {
        out.write(`NDI stopped for window ${data.id}.\n`);
      }
      break;
    case "close":
      out.write(
        data.ids
          ? `Closed ${data.ids.length} window(s).\n`
          : `Closed window ${data.id}.\n`,
      );
      break;
    case "reload":
      out.write(`Reloaded window ${data.id}.\n`);
      break;
    case "update":
      out.write(`Updated window ${data.id}.\n`);
      break;
    case "quit":
      out.write("Grandicast quitting.\n");
      break;
    default:
      break;
  }
}

async function runClient(parsed, userDataPath, { cwd, stdout, stderr }) {
  let request;
  try {
    request = buildRequest(parsed, cwd);
  } catch (err) {
    stderr.write(`Error: ${err.message}\n`);
    return 1;
  }

  try {
    const response = await sendRequest(getSocketPath(userDataPath), request);
    if (!response || response.ok !== true) {
      stderr.write(
        `Error: ${(response && response.error) || "Unknown error"}\n`,
      );
      return 1;
    }
    printResult(request, parsed, response.data, stdout);
    return 0;
  } catch (err) {
    const hint =
      err.code === "ENOENT" ||
      err.code === "ECONNREFUSED" ||
      err.code === "EAGAIN"
        ? "\nGrandicast is not running. Start it with `grandicast` or `grandicast --config <file>`."
        : "";
    stderr.write(`Error: ${err.message}${hint}\n`);
    return 1;
  }
}

module.exports = {
  getArgv,
  parseCli,
  usage,
  version: () => pkg.version,
  normalizeWindowConfig,
  normalizeConfig,
  loadConfig,
  buildRequest,
  getSocketPath,
  startControlServer,
  runClient,
};

"use strict";

const Module = require("node:module");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");

const root = path.resolve(__dirname, "../..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "grandicast-main-"));
const startupConfig = path.join(userData, "startup.json");
const mergeConfig = path.join(userData, "merge.json");

fs.writeFileSync(
  startupConfig,
  JSON.stringify([
    { url: "https://startup.test", width: 640, height: 360 },
  ]),
);
fs.writeFileSync(
  mergeConfig,
  JSON.stringify([
    {
      url: "https://merge.test",
      ndi: { enabled: true, name: "MergeCam", audio: "off" },
    },
  ]),
);

const appEvents = {};
const sentNdi = [];
const fakeApp = {
  isPackaged: false,
  _quit: false,
  _exit: null,
  requestSingleInstanceLock: () => true,
  getPath: () => userData,
  whenReady: () => Promise.resolve(),
  on: (event, handler) => {
    appEvents[event] = handler;
  },
  quit: () => {
    fakeApp._quit = true;
    if (appEvents["before-quit"]) appEvents["before-quit"]();
  },
  exit: (code) => {
    fakeApp._exit = code;
  },
};

let nextWebContentsId = 1;

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.title = options.title;
    this.destroyed = false;
    this.visible = !!options.show;
    this.webContents = {
      id: nextWebContentsId++,
      send: () => {},
      on: () => {},
      insertCSS: () => {},
      reload: () => {},
      loadURL: () => Promise.resolve(),
      capturePage: async () => ({
        getSize: () => ({ width: 10, height: 10 }),
        toBitmap: () => Buffer.alloc(400),
        resize() {
          return this;
        },
      }),
    };
  }

  loadURL() {
    return Promise.resolve();
  }

  loadFile() {}
  setMenuBarVisibility() {}
  setContentSize(width, height) {
    this.width = width;
    this.height = height;
  }
  getTitle() {
    return this.title;
  }
  setTitle(title) {
    this.title = title;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  restore() {}
  show() {
    this.visible = true;
  }
  focus() {}
  close() {
    this.destroyed = true;
    this.emit("closed");
  }
  static fromWebContents() {
    return null;
  }
}

const fakeElectron = {
  app: fakeApp,
  BrowserWindow: FakeWindow,
  ipcMain: { on: () => {}, handle: () => {} },
  session: {
    defaultSession: { setDisplayMediaRequestHandler: () => {} },
  },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
};

const fakeGrandi = {
  version: () => "6.0",
  isSupportedCPU: () => true,
  FrameType: { Progressive: 1 },
  FourCC: { BGRA: 1, FLTp: 2 },
  send: async (options) => {
    sentNdi.push(options.name);
    return {
      video: async () => {},
      audio: async () => {},
      destroy: () => {},
    };
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") return fakeElectron;
  if (request === "grandi") return fakeGrandi;
  return originalLoad.apply(this, arguments);
};

const logs = [];
console.log = (...args) => logs.push(args.join(" "));
console.error = (...args) => logs.push(args.join(" "));

process.argv = ["/fake/electron", ".", "--headless", "--config", startupConfig];
require(path.join(root, "src/main.cjs"));

const cli = require(path.join(root, "src/cli.cjs"));

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

async function run(args) {
  const parsed = cli.parseCli(args);
  const stdout = capture();
  const stderr = capture();
  const code = await cli.runClient(parsed, userData, {
    cwd: process.cwd(),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { args, code, stdout: stdout.text(), stderr: stderr.text() };
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));

  const results = [];
  results.push(await run(["list", "--json"]));
  results.push(
    await run([
      "add",
      "--url",
      "https://added.test",
      "--ndi",
      "--name",
      "AddedCam",
      "--fps",
      "60",
      "--audio",
      "low",
    ]),
  );
  results.push(
    await run([
      "update",
      "2",
      "--width",
      "800",
      "--height",
      "600",
      "--name",
      "RenamedCam",
      "--fps",
      "30",
      "--audio",
      "off",
    ]),
  );
  results.push(await run(["stop", "2"]));
  results.push(await run(["apply", "--config", mergeConfig, "--merge"]));
  results.push(await run(["list", "--json"]));
  results.push(await run(["close", "--all"]));
  results.push(await run(["list", "--json"]));
  results.push(await run(["quit"]));

  await new Promise((resolve) => setTimeout(resolve, 300));

  process.stdout.write(
    JSON.stringify({
      results,
      sentNdi,
      appQuit: fakeApp._quit,
      appExit: fakeApp._exit,
    }),
  );
  process.exit(0);
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});

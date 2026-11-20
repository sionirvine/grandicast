"use strict";

const { app, BrowserWindow, ipcMain, session, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const NdiManager = require("./ndi-manager.cjs");
const cli = require("./cli.cjs");

const AUDIO_BUFFER_PRESETS = {
  low: 1024,
  balanced: 2048,
  high: 4096,
  max: 8192,
};

const browserWindows = new Map(); // windowId → { win, config, ndiManager, ndiActive }
let controlPanel = null;
let controlServer = null;
let nextWindowId = 1;

// ── Settings persistence ─────────────────────────────────────────────────────
function getSettingsPath() {
  return path.join(app.getPath("userData"), "window-settings.json");
}

function loadSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    }
  } catch (e) {
    console.error("[Settings] Failed to load:", e.message);
  }
  return [];
}

function saveSettings(panels) {
  try {
    const settingsPath = getSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify(panels, null, 2), "utf-8");
  } catch (e) {
    console.error("[Settings] Failed to save:", e.message);
  }
}

// ── Control Panel ────────────────────────────────────────────────────────────
function createControlPanel() {
  controlPanel = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 640,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, "preload-control.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "Grandicast",
    backgroundColor: "#0f0f1a",
    show: false,
  });

  controlPanel.loadFile(path.join(__dirname, "control-panel.html"));
  controlPanel.setMenuBarVisibility(false);
  controlPanel.once("ready-to-show", () => {
    controlPanel.show();
  });

  controlPanel.on("closed", () => {
    for (const [, data] of browserWindows) {
      data.ndiManager.stop();
      if (!data.win.isDestroyed()) data.win.close();
    }
    browserWindows.clear();
    controlPanel = null;
    app.quit();
  });
}

function focusControlPanel() {
  if (!controlPanel || controlPanel.isDestroyed()) return false;
  if (controlPanel.isMinimized()) controlPanel.restore();
  controlPanel.show();
  controlPanel.focus();
  return true;
}

function notifyControlPanel(channel, payload) {
  if (controlPanel && !controlPanel.isDestroyed()) {
    controlPanel.webContents.send(channel, payload);
  }
}

// ── Managed windows ──────────────────────────────────────────────────────────
function panelPayload(id) {
  const data = browserWindows.get(id);
  if (!data) return null;
  return {
    id,
    config: {
      url: data.config.url || "",
      width: data.config.width,
      height: data.config.height,
      transparent: !!data.config.transparent,
      frameless: !!data.config.frameless,
      hidden: !!data.config.hidden,
      ndiName: data.config.ndiName || "",
      fps: data.config.fps || 30,
      audioPreset: data.config.audioPreset || "off",
    },
    ndiActive: !!data.ndiActive,
  };
}

async function createManagedWindow(config, { notifyPanel = true } = {}) {
  const normalized = cli.normalizeWindowConfig(config);
  const id = nextWindowId++;

  const win = new BrowserWindow({
    width: normalized.width,
    height: normalized.height,
    transparent: normalized.transparent,
    backgroundColor: normalized.transparent ? "#00000000" : "#ffffffff",
    frame: !(normalized.transparent || normalized.frameless),
    hasShadow: !normalized.transparent,
    show: !normalized.hidden,
    webPreferences: {
      preload: path.join(__dirname, "preload-browser.cjs"),
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments:
        normalized.transparent || normalized.frameless
          ? ["--grandicast-draggable"]
          : [],
    },
    title: normalized.title || `Grandicast - Window ${id}`,
  });

  win.setContentSize(normalized.width, normalized.height);

  win.loadURL(normalized.url).catch((err) => {
    console.error(`Failed to load URL ${normalized.url}:`, err.message);
  });

  if (normalized.transparent) {
    win.webContents.on("dom-ready", () => {
      win.webContents.insertCSS(
        "html, body { background: transparent !important; }",
      );
    });
  }

  const ndiManager = new NdiManager(id, win);

  browserWindows.set(id, {
    win,
    config: {
      url: normalized.url,
      width: normalized.width,
      height: normalized.height,
      transparent: normalized.transparent,
      frameless: normalized.frameless,
      hidden: normalized.hidden,
      title: normalized.title || `Grandicast - Window ${id}`,
      ndiName: normalized.ndi.name,
      fps: normalized.ndi.fps,
      audioPreset: normalized.ndi.audio,
    },
    ndiManager,
    ndiActive: false,
    audioEnabled: false,
    audioBufferSize: 4096,
  });

  win.webContents.on("did-finish-load", () => {
    const data = browserWindows.get(id);
    if (data && data.ndiActive && data.audioEnabled && !data.win.isDestroyed()) {
      data.win.webContents.send("start-audio-capture", {
        bufferSize: data.audioBufferSize,
      });
    }
  });

  win.on("closed", () => {
    const data = browserWindows.get(id);
    if (data) {
      data.ndiManager.stop();
      browserWindows.delete(id);
    }
    notifyControlPanel("window-closed", id);
  });

  if (notifyPanel) {
    notifyControlPanel("window-created", panelPayload(id));
  }

  return id;
}

async function startManagedNdi(id, options = {}) {
  const data = browserWindows.get(id);
  if (!data || data.win.isDestroyed()) {
    throw new Error(`Window not found: ${id}`);
  }

  const ndiName =
    (options.ndiName || data.config.ndiName || "").trim() ||
    `Grandicast-${id}`;
  const fps = Number(options.fps) > 0 ? Number(options.fps) : data.config.fps || 30;
  const audioPreset =
    options.audioPreset || data.config.audioPreset || "off";
  const audioEnabled = audioPreset !== "off";
  const audioBufferSize =
    Number(options.audioBufferSize) > 0
      ? Number(options.audioBufferSize)
      : AUDIO_BUFFER_PRESETS[audioPreset] || 2048;

  await data.ndiManager.start(
    ndiName,
    fps,
    data.config.width,
    data.config.height,
    audioEnabled,
  );

  data.ndiActive = true;
  data.audioEnabled = audioEnabled;
  data.audioBufferSize = audioBufferSize;
  data.config.ndiName = ndiName;
  data.config.fps = fps;
  data.config.audioPreset = audioPreset;

  if (audioEnabled && !data.win.isDestroyed()) {
    data.win.webContents.send("start-audio-capture", {
      bufferSize: audioBufferSize,
    });
  }

  notifyControlPanel("window-ndi", {
    id,
    active: true,
    ndiName,
    fps,
    audioPreset,
  });

  return { id, ndiName, fps, audioPreset };
}

async function stopManagedNdi(id) {
  const data = browserWindows.get(id);
  if (!data) throw new Error(`Window not found: ${id}`);

  if (!data.win.isDestroyed()) {
    data.win.webContents.send("stop-audio-capture");
  }

  await data.ndiManager.stop();
  data.ndiActive = false;

  notifyControlPanel("window-ndi", {
    id,
    active: false,
    ndiName: data.config.ndiName,
    fps: data.config.fps,
    audioPreset: data.config.audioPreset,
  });

  return { id };
}

async function closeManagedWindow(id) {
  const data = browserWindows.get(id);
  if (!data) throw new Error(`Window not found: ${id}`);

  data.ndiManager.stop();
  if (data.win.isDestroyed()) {
    browserWindows.delete(id);
    return { id };
  }

  await new Promise((resolve) => {
    data.win.once("closed", resolve);
    data.win.close();
  });

  return { id };
}

function windowSummary(id) {
  const data = browserWindows.get(id);
  if (!data) return null;
  return {
    id,
    url: data.config.url,
    width: data.config.width,
    height: data.config.height,
    transparent: !!data.config.transparent,
    frameless: !!data.config.frameless,
    hidden: !!data.config.hidden,
    title: data.config.title,
    ndiActive: !!data.ndiActive,
    ndiName: data.config.ndiName || `Grandicast-${id}`,
    fps: data.config.fps || 30,
    audioPreset: data.config.audioPreset || "off",
    state: data.ndiActive ? "ndi" : "running",
  };
}

function listWindows() {
  return [...browserWindows.keys()].map(windowSummary).filter(Boolean);
}

function resolveWindowId(target) {
  if (target === undefined || target === null || target === "") {
    throw new Error("A window id or name is required");
  }

  const numeric = Number.parseInt(String(target), 10);
  if (String(numeric) === String(target) && browserWindows.has(numeric)) {
    return numeric;
  }

  for (const [id, data] of browserWindows) {
    if (
      data.config.ndiName === target ||
      data.config.title === target ||
      data.win.getTitle() === target
    ) {
      return id;
    }
  }

  throw new Error(`Window not found: ${target}`);
}

async function updateManagedWindow(id, patch, { notifyPanel = true } = {}) {
  const data = browserWindows.get(id);
  if (!data || data.win.isDestroyed()) {
    throw new Error(`Window not found: ${id}`);
  }

  if (patch.url !== undefined) {
    const url = String(patch.url).trim();
    if (!url) throw new Error("url cannot be empty");
    if (url !== data.config.url) {
      await data.win.loadURL(url).catch((err) => {
        console.error(`Failed to load URL ${url}:`, err.message);
      });
      data.config.url = url;
    }
  }

  if (patch.width !== undefined || patch.height !== undefined) {
    const width = Number(patch.width) > 0 ? Number(patch.width) : data.config.width;
    const height =
      Number(patch.height) > 0 ? Number(patch.height) : data.config.height;
    data.win.setContentSize(width, height);
    data.config.width = width;
    data.config.height = height;
    if (data.ndiActive) {
      data.ndiManager.width = width;
      data.ndiManager.height = height;
    }
  }

  if (patch.title !== undefined) {
    data.config.title = String(patch.title);
    data.win.setTitle(data.config.title);
  }

  let restartNdi = false;

  if (patch.ndiName !== undefined) {
    const name = String(patch.ndiName).trim() || `Grandicast-${id}`;
    if (name !== data.config.ndiName) {
      data.config.ndiName = name;
      if (data.ndiActive) restartNdi = true;
    }
  }

  if (patch.fps !== undefined) {
    const fps = Number(patch.fps);
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new Error("fps must be a positive integer");
    }
    data.config.fps = fps;
    if (data.ndiActive) data.ndiManager.fps = fps;
  }

  if (patch.audioPreset !== undefined) {
    if (patch.audioPreset !== data.config.audioPreset) {
      data.config.audioPreset = patch.audioPreset;
      if (data.ndiActive) restartNdi = true;
    }
  }

  if (restartNdi) {
    await stopManagedNdi(id);
    await startManagedNdi(id);
  }

  if (notifyPanel) {
    notifyControlPanel("window-updated", panelPayload(id));
  }

  return { ...windowSummary(id) };
}

async function applyWindows(windows, { merge = false } = {}) {
  const normalized = (Array.isArray(windows) ? windows : []).map(
    cli.normalizeWindowConfig,
  );

  if (!merge) {
    const existing = [...browserWindows.keys()];
    await Promise.all(
      existing.map((id) => closeManagedWindow(id).catch(() => {})),
    );
  }

  const ids = [];
  for (const config of normalized) {
    const id = await createManagedWindow(config);
    ids.push(id);
    if (config.ndi.enabled) {
      await startManagedNdi(id, {
        ndiName: config.ndi.name,
        fps: config.ndi.fps,
        audioPreset: config.ndi.audio,
      });
    }
  }

  return ids.map(windowSummary).filter(Boolean);
}

// ── CLI command dispatcher ───────────────────────────────────────────────────
async function dispatchCommand(request) {
  const command = request && request.command;

  switch (command) {
    case "activate": {
      if (!controlPanel || controlPanel.isDestroyed()) {
        createControlPanel();
        return { activated: true, created: true };
      }
      return { activated: focusControlPanel(), created: false };
    }

    case "list":
      return { windows: listWindows() };

    case "add": {
      const window = cli.normalizeWindowConfig(request.window);
      const id = await createManagedWindow(window);
      if (window.ndi.enabled) {
        await startManagedNdi(id, {
          ndiName: window.ndi.name,
          fps: window.ndi.fps,
          audioPreset: window.ndi.audio,
        });
      }
      return { windows: [windowSummary(id)] };
    }

    case "apply": {
      const windows = await applyWindows(request.windows, {
        merge: !!request.merge,
      });
      return { windows };
    }

    case "update": {
      const id = resolveWindowId(request.target);
      const summary = await updateManagedWindow(id, request.patch || {});
      return summary;
    }

    case "reload": {
      const id = resolveWindowId(request.target);
      const data = browserWindows.get(id);
      if (!data || data.win.isDestroyed()) {
        throw new Error(`Window not found: ${id}`);
      }
      data.win.webContents.reload();
      return { id };
    }

    case "start": {
      const id = resolveWindowId(request.target);
      return startManagedNdi(id, request.options || {});
    }

    case "stop": {
      if (request.all) {
        const ids = [...browserWindows.keys()].filter(
          (id) => browserWindows.get(id).ndiActive,
        );
        for (const id of ids) await stopManagedNdi(id);
        return { ids };
      }
      const id = resolveWindowId(request.target);
      return stopManagedNdi(id);
    }

    case "close": {
      if (request.all) {
        const ids = [...browserWindows.keys()];
        await Promise.all(ids.map((id) => closeManagedWindow(id)));
        return { ids };
      }
      const id = resolveWindowId(request.target);
      return closeManagedWindow(id);
    }

    case "quit":
      setTimeout(() => app.quit(), 100);
      return { quitting: true };

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ── IPC: Audio PCM from browser renderers ────────────────────────────────────
ipcMain.on("audio-pcm-data", (event, { noSamples, planarBuf }) => {
  const senderId = event.sender.id;
  for (const [, data] of browserWindows) {
    if (!data.win.isDestroyed() && data.win.webContents.id === senderId) {
      if (data.ndiManager && data.ndiActive) {
        data.ndiManager.pushAudio(Buffer.from(planarBuf), noSamples);
      }
      break;
    }
  }
});

// ── IPC: Dragging frameless windows ──────────────────────────────────────────
const activeDrags = new Map();

function stopDrag(senderId) {
  const drag = activeDrags.get(senderId);
  if (!drag) return;
  clearInterval(drag.timer);
  activeDrags.delete(senderId);
}

ipcMain.on("window-drag-start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const senderId = event.sender.id;
  stopDrag(senderId);

  const cursorStart = screen.getCursorScreenPoint();
  const boundsStart = win.getBounds();

  const timer = setInterval(() => {
    if (win.isDestroyed()) return stopDrag(senderId);
    const cursor = screen.getCursorScreenPoint();
    win.setBounds({
      x: boundsStart.x + cursor.x - cursorStart.x,
      y: boundsStart.y + cursor.y - cursorStart.y,
      width: boundsStart.width,
      height: boundsStart.height,
    });
  }, 1000 / 60);

  activeDrags.set(senderId, { win, timer });
});

ipcMain.on("window-drag-end", (event) => stopDrag(event.sender.id));

// ── IPC: Window management ───────────────────────────────────────────────────
ipcMain.handle("create-window", async (_ev, config) => {
  return createManagedWindow(config, { notifyPanel: false });
});

ipcMain.handle("update-window", async (_ev, { id, config }) => {
  try {
    await updateManagedWindow(id, config, { notifyPanel: false });
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("reload-window", async (_ev, id) => {
  const data = browserWindows.get(id);
  if (!data || data.win.isDestroyed()) return false;
  data.win.webContents.reload();
  return true;
});

ipcMain.handle("close-window", async (_ev, id) => {
  try {
    await closeManagedWindow(id);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("list-windows", async () => listWindows());

// ── IPC: NDI ─────────────────────────────────────────────────────────────────
ipcMain.handle("start-ndi", async (_ev, options) => {
  try {
    const data = await startManagedNdi(options.id, options);
    return { success: true, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("stop-ndi", async (_ev, id) => {
  try {
    await stopManagedNdi(id);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("check-ndi", async () => {
  try {
    const grandi = require("grandi");
    return {
      available: true,
      version: grandi.version(),
      cpuOk: grandi.isSupportedCPU(),
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
});

// ── IPC: BroadcastChannel bridge ─────────────────────────────────────────────
ipcMain.on("broadcast-channel-message", (event, payload) => {
  const senderId = event.sender.id;
  for (const [, data] of browserWindows) {
    if (!data.win.isDestroyed() && data.win.webContents.id !== senderId) {
      data.win.webContents.send("broadcast-channel-message", payload);
    }
  }
});

// ── IPC: Settings persistence ────────────────────────────────────────────────
ipcMain.handle("save-settings", async (_ev, panels) => {
  saveSettings(panels);
  return true;
});

ipcMain.handle("load-settings", async () => {
  return loadSettings();
});

// ── App lifecycle ────────────────────────────────────────────────────────────
function getErrorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function main() {
  const args = cli.getArgv(process.argv, app.isPackaged);

  let parsed;
  try {
    parsed = cli.parseCli(args);
  } catch (err) {
    process.stderr.write(`Error: ${getErrorMessage(err)}\n\n${cli.usage()}\n`);
    app.exit(1);
    return;
  }

  if (parsed.options.help) {
    process.stdout.write(cli.usage() + "\n");
    app.exit(0);
    return;
  }

  if (parsed.options.version) {
    process.stdout.write(cli.version() + "\n");
    app.exit(0);
    return;
  }

  if (parsed.options["user-data-dir"]) {
    const userDataPath = path.resolve(
      process.cwd(),
      parsed.options["user-data-dir"],
    );
    fs.mkdirSync(userDataPath, { recursive: true });
    app.setPath("userData", userDataPath);
  }

  let startupRequest = null;
  if (!parsed.command && (parsed.options.config || parsed.options.url)) {
    try {
      startupRequest = cli.buildRequest(parsed, process.cwd());
    } catch (err) {
      process.stderr.write(`Error: ${getErrorMessage(err)}\n`);
      app.exit(1);
      return;
    }
  }

  const gotLock = app.requestSingleInstanceLock();

  if (!gotLock) {
    app
      .whenReady()
      .then(async () => {
        const code = await cli.runClient(parsed, app.getPath("userData"), {
          cwd: process.cwd(),
          stdout: process.stdout,
          stderr: process.stderr,
        });
        app.exit(code);
      })
      .catch((err) => {
        process.stderr.write(`Error: ${getErrorMessage(err)}\n`);
        app.exit(1);
      });
    return;
  }

  if (parsed.command) {
    process.stderr.write(
      "Error: Grandicast is not running. Start it with `grandicast` or " +
        "`grandicast --config <file>` before using commands.\n",
    );
    app.exit(1);
    return;
  }

  app.on("second-instance", () => {
    focusControlPanel();
  });

  app.whenReady().then(async () => {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      callback({ video: request.frame, audio: "loopback" });
    });

    try {
      controlServer = await cli.startControlServer(
        cli.getSocketPath(app.getPath("userData")),
        dispatchCommand,
      );
    } catch (err) {
      console.error("[CLI] Failed to start control server:", err.message);
    }

    const showPanel =
      !parsed.options.headless &&
      (parsed.options.panel ||
        (!parsed.options.config && !parsed.options.url));

    if (showPanel) createControlPanel();

    if (startupRequest) {
      try {
        await dispatchCommand(startupRequest);
      } catch (err) {
        console.error(
          "[CLI] Failed to apply startup config:",
          getErrorMessage(err),
        );
      }
    }
  });

  app.on("window-all-closed", () => {
    /* keep running until the control panel closes or quit is requested */
  });

  app.on("before-quit", () => {
    for (const [, data] of browserWindows) {
      data.ndiManager.stop();
    }
    if (controlServer) {
      controlServer.close();
      controlServer = null;
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => app.quit());
  }
}

main();

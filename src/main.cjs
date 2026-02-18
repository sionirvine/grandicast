"use strict";

const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const NdiManager = require("./ndi-manager.cjs");

// ── State ────────────────────────────────────────────────────────────────────
const browserWindows = new Map(); // windowId → { win, config, ndiManager, ndiActive }
let controlPanel = null;
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

app.whenReady().then(() => {
  // Auto-approve getDisplayMedia requests so the preload can capture tab audio
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    callback({ video: request.frame, audio: "loopback" });
  });
  createControlPanel();
});
app.on("window-all-closed", () => {
  /* keep running until control panel closes */
});

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

// ── IPC: Window management ───────────────────────────────────────────────────
ipcMain.handle("create-window", async (_ev, config) => {
  const id = nextWindowId++;
  const width = config.width || 1280;
  const height = config.height || 720;
  const transparent = !!config.transparent;
  const frameless = !!config.frameless;
  const hidden = !!config.hidden;

  const win = new BrowserWindow({
    width,
    height,
    transparent,
    backgroundColor: transparent ? "#00000000" : "#ffffffff",
    frame: !(transparent || frameless),
    hasShadow: !transparent,
    show: !hidden,
    webPreferences: {
      preload: path.join(__dirname, "preload-browser.cjs"),
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
    title: config.title || `Grandicast - Window ${id}`,
  });

  win.setContentSize(width, height);

  if (config.url) {
    win
      .loadURL(config.url)
      .catch((err) =>
        console.error(`Failed to load URL ${config.url}:`, err.message),
      );
  }

  if (transparent) {
    win.webContents.on("dom-ready", () => {
      win.webContents.insertCSS(
        "html, body { background: transparent !important; }",
      );
    });
  }

  const ndiManager = new NdiManager(id, win);

  browserWindows.set(id, {
    win,
    config: { ...config, width, height },
    ndiManager,
    ndiActive: false,
    audioEnabled: false,
    audioBufferSize: 4096,
  });

  // After any navigation / reload, re-start audio capture if NDI is active
  win.webContents.on("did-finish-load", () => {
    const d = browserWindows.get(id);
    if (d && d.ndiActive && d.audioEnabled && !d.win.isDestroyed()) {
      d.win.webContents.send("start-audio-capture", {
        bufferSize: d.audioBufferSize,
      });
    }
  });

  win.on("closed", () => {
    const data = browserWindows.get(id);
    if (data) {
      data.ndiManager.stop();
      browserWindows.delete(id);
    }
    if (controlPanel && !controlPanel.isDestroyed()) {
      controlPanel.webContents.send("window-closed", id);
    }
  });

  return id;
});

ipcMain.handle("update-window", async (_ev, { id, config }) => {
  const data = browserWindows.get(id);
  if (!data || data.win.isDestroyed()) return false;

  if (config.url !== undefined && config.url !== data.config.url) {
    data.win.loadURL(config.url).catch(() => {});
    data.config.url = config.url;
  }

  if (config.width && config.height) {
    data.win.setContentSize(config.width, config.height);
    data.config.width = config.width;
    data.config.height = config.height;
    // Live-update NDI capture resolution
    if (data.ndiActive) {
      data.ndiManager.width = config.width;
      data.ndiManager.height = config.height;
    }
  }

  if (config.title) {
    data.win.setTitle(config.title);
    data.config.title = config.title;
  }

  return true;
});

ipcMain.handle("reload-window", async (_ev, id) => {
  const data = browserWindows.get(id);
  if (!data || data.win.isDestroyed()) return false;
  data.win.webContents.reload();
  return true;
});

ipcMain.handle("close-window", async (_ev, id) => {
  const data = browserWindows.get(id);
  if (!data) return false;
  data.ndiManager.stop();
  if (!data.win.isDestroyed()) data.win.close();
  browserWindows.delete(id);
  return true;
});

// ── IPC: NDI ─────────────────────────────────────────────────────────────────
ipcMain.handle(
  "start-ndi",
  async (_ev, { id, ndiName, fps, audioEnabled, audioBufferSize }) => {
    const data = browserWindows.get(id);
    if (!data || data.win.isDestroyed())
      return { success: false, error: "Window not found" };

    try {
      await data.ndiManager.start(
        ndiName || `Grandicast-${id}`,
        fps || 30,
        data.config.width || 1280,
        data.config.height || 720,
        !!audioEnabled,
      );
      data.ndiActive = true;
      data.audioEnabled = !!audioEnabled;
      data.audioBufferSize = audioBufferSize || 4096;

      // Tell the browser window renderer to start capturing tab audio
      if (audioEnabled && !data.win.isDestroyed()) {
        data.win.webContents.send("start-audio-capture", {
          bufferSize: data.audioBufferSize,
        });
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
);

ipcMain.handle("stop-ndi", async (_ev, id) => {
  const data = browserWindows.get(id);
  if (!data) return false;

  // Tell renderer to stop audio capture
  if (!data.win.isDestroyed()) {
    data.win.webContents.send("stop-audio-capture");
  }

  await data.ndiManager.stop();
  data.ndiActive = false;
  return true;
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

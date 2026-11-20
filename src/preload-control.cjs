"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grandicast", {
  // Window lifecycle
  createWindow: (config) => ipcRenderer.invoke("create-window", config),
  updateWindow: (id, config) =>
    ipcRenderer.invoke("update-window", { id, config }),
  reloadWindow: (id) => ipcRenderer.invoke("reload-window", id),
  closeWindow: (id) => ipcRenderer.invoke("close-window", id),
  listWindows: () => ipcRenderer.invoke("list-windows"),

  // NDI control
  startNdi: (id, ndiName, fps, audioEnabled, audioBufferSize, audioPreset) =>
    ipcRenderer.invoke("start-ndi", {
      id,
      ndiName,
      fps,
      audioEnabled,
      audioBufferSize,
      audioPreset,
    }),
  stopNdi: (id) => ipcRenderer.invoke("stop-ndi", id),
  checkNdi: () => ipcRenderer.invoke("check-ndi"),

  // Settings persistence
  saveSettings: (panels) => ipcRenderer.invoke("save-settings", panels),
  loadSettings: () => ipcRenderer.invoke("load-settings"),

  // Events from main process
  onWindowClosed: (callback) => {
    ipcRenderer.on("window-closed", (_ev, id) => callback(id));
  },
  onWindowCreated: (callback) => {
    ipcRenderer.on("window-created", (_ev, payload) => callback(payload));
  },
  onWindowUpdated: (callback) => {
    ipcRenderer.on("window-updated", (_ev, payload) => callback(payload));
  },
  onNdiState: (callback) => {
    ipcRenderer.on("window-ndi", (_ev, payload) => callback(payload));
  },
});

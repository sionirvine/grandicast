"use strict";

/**
 * Preload for the "Change URL" dialog opened from a window's right-click menu.
 */

const { contextBridge, ipcRenderer } = require("electron");

const arg = process.argv.find((a) => a.startsWith("--grandicast-initial-url="));
const initialUrl = arg
  ? decodeURIComponent(arg.slice("--grandicast-initial-url=".length))
  : "";

contextBridge.exposeInMainWorld("urlPrompt", {
  initialUrl,
  submit: (url) => ipcRenderer.send("url-prompt-submit", String(url)),
  cancel: () => ipcRenderer.send("url-prompt-cancel"),
});

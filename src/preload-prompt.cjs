"use strict";

/**
 * Preload for the small dialogs opened from a window's right-click menu
 * (Change URL, custom size). The main process passes the dialog's title and
 * fields as an encoded JSON argument.
 */

const { contextBridge, ipcRenderer } = require("electron");

const PREFIX = "--grandicast-prompt=";
const arg = process.argv.find((a) => a.startsWith(PREFIX));
let config = { title: "", fields: [] };
try {
  if (arg) config = JSON.parse(decodeURIComponent(arg.slice(PREFIX.length)));
} catch {
  // keep the empty dialog
}

contextBridge.exposeInMainWorld("promptDialog", {
  config,
  submit: (values) => ipcRenderer.send("prompt-dialog-submit", values),
  cancel: () => ipcRenderer.send("prompt-dialog-cancel"),
});

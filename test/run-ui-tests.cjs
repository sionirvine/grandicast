"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sourcePath = path.join(root, "src/control-panel.html");

if (!fs.existsSync(chromePath)) {
  console.error("Google Chrome not found at", chromePath);
  process.exit(1);
}

const mockScript = `
window.__mock = {
  saved: [
    { url: "https://saved-one.test", width: 1280, height: 720, ndiName: "SavedOne", fps: 30, audioPreset: "off" },
    { url: "https://saved-two.test", width: 1280, height: 720, ndiName: "SavedTwo", fps: 30, audioPreset: "off" }
  ],
  windows: [
    { id: 10, url: "https://running.test", width: 800, height: 600, transparent: false, frameless: false, hidden: false, ndiName: "Running", fps: 30, audioPreset: "off", ndiActive: true }
  ],
  created: [],
  closed: [],
  startedNdi: null,
  stoppedNdi: null,
  updated: null,
  reloaded: null,
  savedSettings: null,
  checkNdi: null,
  onClosed: null,
  onCreated: null,
  onUpdated: null,
  onNdi: null
};
window.grandicast = {
  createWindow: async (config) => { window.__mock.created.push(config); return 99; },
  updateWindow: async (id, config) => { window.__mock.updated = { id, config }; return true; },
  reloadWindow: async (id) => { window.__mock.reloaded = id; return true; },
  closeWindow: async (id) => { window.__mock.closed.push(id); return true; },
  listWindows: async () => window.__mock.windows,
  startNdi: async (id, name, fps, audioEnabled, bufferSize, preset) => {
    window.__mock.startedNdi = { id, name, fps, audioEnabled, bufferSize, preset };
    return { success: true };
  },
  stopNdi: async (id) => { window.__mock.stoppedNdi = id; return true; },
  checkNdi: async () => ({ available: true, version: "NDI 6.0" }),
  saveSettings: async (panels) => { window.__mock.savedSettings = panels; return true; },
  loadSettings: async () => window.__mock.saved,
  onWindowClosed: (cb) => { window.__mock.onClosed = cb; },
  onWindowCreated: (cb) => { window.__mock.onCreated = cb; },
  onWindowUpdated: (cb) => { window.__mock.onUpdated = cb; },
  onNdiState: (cb) => { window.__mock.onNdi = cb; }
};
`;

const testScript = `
(async () => {
  const results = [];
  const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: extra === undefined ? "" : String(extra) });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const settle = () => wait(40);

  for (let i = 0; i < 200 && !uiReady; i += 1) await wait(10);
  check("ui becomes ready", uiReady);
  await settle();

  check("saved cards restored", cards.size >= 2);
  check("running window synced", [...cards.values()].some((c) => c.windowId === 10));

  const pids = [...cards.keys()];
  const pidFor = (predicate) => {
    for (const [pid, card] of cards) if (predicate(pid, card)) return pid;
    return null;
  };
  const pidSaved1 = pids.find((pid) => $("url-" + pid).value === "https://saved-one.test");
  const pidRunning = pidFor((pid, card) => card.windowId === 10);

  check("running card attached", pidRunning !== null);
  check("running badge shows NDI LIVE", $("badge-" + pidRunning).textContent === "NDI LIVE");
  check("ndi badge available", document.getElementById("ndi-badge").className.includes("ok"));

  window.__mock.onCreated({
    id: 20,
    config: {
      url: "https://created.test",
      width: 800,
      height: 450,
      transparent: false,
      frameless: true,
      hidden: true,
      ndiName: "Created",
      fps: 60,
      audioPreset: "high"
    },
    ndiActive: false
  });
  await settle();

  const pidCreated = pidFor((pid, card) => card.windowId === 20);
  check("external create adds card", pidCreated !== null);
  check("external create keeps hidden flag", $("hidden-" + pidCreated).checked === true);
  check("external create keeps frameless flag", $("frameless-" + pidCreated).checked === true);
  check("external create persists settings", !!window.__mock.savedSettings && window.__mock.savedSettings.some((p) => p.url === "https://created.test"));

  window.__mock.onUpdated({
    id: 20,
    config: {
      url: "https://updated.test",
      width: 1000,
      height: 500,
      ndiName: "Updated",
      fps: 24,
      audioPreset: "low"
    },
    ndiActive: false
  });
  await settle();
  check("external update changes url", $("url-" + pidCreated).value === "https://updated.test");
  check("external update changes width", $("w-" + pidCreated).value === "1000");

  window.__mock.onNdi({ id: 20, active: true, ndiName: "Updated", fps: 24, audioPreset: "low" });
  await settle();
  check("external ndi activates badge", $("badge-" + pidCreated).textContent === "NDI LIVE");
  check("external ndi changes button label", $("btnNdi-" + pidCreated).textContent.includes("Stop NDI"));
  check("external ndi keeps audio preset", $("audio-" + pidCreated).value === "low");

  const settings = gatherSettings();
  check("gatherSettings returns every card", settings.length === cards.size);
  check("gatherSettings contains updated url", settings.some((p) => p.url === "https://updated.test"));

  const beforeAdd = cards.size;
  document.getElementById("add-btn").click();
  await settle();
  check("add button adds a card", cards.size === beforeAdd + 1);
  check("add button persists settings", window.__mock.savedSettings.length === cards.size);

  $("url-" + pidSaved1).value = "https://started.test";
  await startWindow(pidSaved1);
  await settle();
  check("startWindow creates a runtime window", cards.get(pidSaved1).windowId === 99);
  check("startWindow sends config", window.__mock.created.length === 1 && window.__mock.created[0].url === "https://started.test");
  check("startWindow marks running", $("badge-" + pidSaved1).textContent === "RUNNING");

  $("ndi-" + pidSaved1).value = "StartedCam";
  $("fps-" + pidSaved1).value = "60";
  $("audio-" + pidSaved1).value = "high";
  await toggleNdi(pidSaved1);
  await settle();
  check("toggleNdi starts NDI", !!window.__mock.startedNdi && window.__mock.startedNdi.id === 99);
  check("toggleNdi passes audio preset", !!window.__mock.startedNdi && window.__mock.startedNdi.preset === "high");
  check("toggleNdi sets card active", cards.get(pidSaved1).ndiActive === true);

  await toggleNdi(pidSaved1);
  await settle();
  check("toggleNdi stops NDI", window.__mock.stoppedNdi === 99);
  check("toggleNdi clears card active", cards.get(pidSaved1).ndiActive === false);

  await reloadWindow(pidSaved1);
  await settle();
  check("reloadWindow updates current url", !!window.__mock.updated && window.__mock.updated.id === 99);
  check("reloadWindow reloads page", window.__mock.reloaded === 99);

  window.__mock.onClosed(20);
  await settle();
  check("close event detaches card", pidFor((pid, card) => card.windowId === 20) === null);
  check("close event resets badge", $("badge-" + pidCreated).textContent === "IDLE");

  await stopWindow(pidSaved1);
  await settle();
  check("stopWindow closes runtime", window.__mock.closed.includes(99));
  check("stopWindow resets card", cards.get(pidSaved1).windowId === null);

  const removedPid = pidSaved1;
  removeCard(removedPid);
  await settle();
  check("removeCard deletes card", !cards.has(removedPid));
  check("removeCard persists settings", window.__mock.savedSettings.length === cards.size);

  window.__TEST_RESULTS__ = results;
  window.__TEST_DONE__ = true;

  const failed = results.filter((r) => !r.ok);
  const report = document.createElement("pre");
  report.style.cssText = "margin:0;padding:24px;white-space:pre-wrap;font:14px ui-monospace,monospace;background:#0f0f1a;color:#d4d4d8;min-height:100vh;";
  report.textContent =
    (failed.length ? "FAIL" : "PASS") +
    " " +
    results.length +
    " checks\\n\\n" +
    results.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.name + (r.extra ? " (" + r.extra + ")" : "")).join("\\n");
  document.body.innerHTML = "";
  document.body.appendChild(report);
})().catch((error) => {
  window.__TEST_RESULTS__ = [{ name: "harness crashed", ok: false, extra: String((error && error.stack) || error) }];
  window.__TEST_DONE__ = true;
  const report = document.createElement("pre");
  report.style.cssText = "padding:24px;white-space:pre-wrap;font:14px ui-monospace,monospace;background:#0f0f1a;color:#fca5a5;";
  report.textContent = "CRASH\\n\\n" + String((error && error.stack) || error);
  document.body.innerHTML = "";
  document.body.appendChild(report);
});
`;

function buildHarness() {
  const html = fs.readFileSync(sourcePath, "utf8");
  const withMock = html.replace("<script>", `<script>${mockScript}</script>\n    <script>`);
  if (withMock === html) throw new Error("Could not inject mock API into control panel");
  return withMock.replace("</body>", `    <script>${testScript}</script>\n  </body>`);
}

function screenBounds() {
  try {
    const raw = execFileSync(
      "osascript",
      ["-e", 'tell application "Finder" to get bounds of window of desktop'],
      { encoding: "utf8" },
    ).trim();
    const [x, y, right, bottom] = raw.split(",").map((n) => Number(n.trim()));
    if ([x, y, right, bottom].every(Number.isFinite)) {
      return { width: right - x, height: bottom - y };
    }
  } catch {}
  return { width: 1920, height: 1080 };
}

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForPage(port, url) {
  for (let i = 0; i < 100; i += 1) {
    const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    if (Array.isArray(pages)) {
      const page = pages.find((p) => p.type === "page" && p.url === url);
      if (page) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome did not expose the test page");
}

function connect(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;

    socket.onopen = () => {
      resolve({
        socket,
        call(method, params) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            socket.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
      });
    };
    socket.onerror = (event) => reject(event.error || new Error("WebSocket error"));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { res, rej } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rej(new Error(message.error.message));
      else res(message.result);
    };
  });
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grandicast-ui-"));
  const harnessPath = path.join(tempDir, "control-panel.test.html");
  fs.writeFileSync(harnessPath, buildHarness());

  const profileDir = path.join(tempDir, "chrome-profile");
  const port = 9300 + Math.floor(Math.random() * 500);
  const bounds = screenBounds();
  const width = Math.max(960, Math.floor(bounds.width * 0.45));
  const height = Math.max(700, Math.floor(bounds.height * 0.92));
  const x = Math.max(0, bounds.width - width);
  const y = 25;
  const url = pathToFileURL(harnessPath).href;

  const chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--window-position=${x},${y}`,
      `--window-size=${width},${height}`,
      "--new-window",
      url,
    ],
    { detached: true, stdio: "ignore" },
  );
  chrome.unref();

  const page = await waitForPage(port, url);
  const client = await connect(page.webSocketDebuggerUrl);
  await client.call("Runtime.enable");

  let results = null;
  for (let i = 0; i < 300; i += 1) {
    const response = await client.call("Runtime.evaluate", {
      expression:
        "window.__TEST_DONE__ ? JSON.stringify(window.__TEST_RESULTS__) : null",
      returnByValue: true,
    });
    const value = response.result && response.result.value;
    if (value) {
      results = JSON.parse(value);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  client.socket.close();

  if (!results) {
    console.error("UI tests timed out");
    process.exit(1);
  }

  const failed = results.filter((r) => !r.ok);
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.extra ? ` (${result.extra})` : ""}`);
  }
  console.log(
    `\n${failed.length ? "FAILED" : "PASSED"}: ${results.length - failed.length}/${results.length} checks`,
  );
  console.log(`Chrome test window left open on the right side of the screen.`);

  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

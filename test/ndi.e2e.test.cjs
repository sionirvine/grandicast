"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { Writable } = require("node:stream");

const root = path.resolve(__dirname, "..");
const cli = require(path.join(root, "src/cli.cjs"));
const electronPath = require("electron");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function positionWindowsRight() {
  const bounds = screenBounds();
  const panelWidth = 960;
  const panelHeight = Math.min(650, bounds.height - 120);
  const panelX = Math.max(0, bounds.width - panelWidth - 20);
  const panelY = 30;
  const browserWidth = 640;
  const browserHeight = 392;
  const browserX = Math.max(0, bounds.width - browserWidth - 20);
  const browserY = Math.min(
    bounds.height - browserHeight - 20,
    panelY + panelHeight + 24,
  );

  const script = `
tell application "System Events"
  tell process "Electron"
    repeat with w in windows
      set t to name of w
      if t is "Grandicast" then
        set position of w to {${panelX}, ${panelY}}
        set size of w to {${panelWidth}, ${panelHeight}}
      else if t starts with "Grandicast" then
        set position of w to {${browserX}, ${browserY}}
      end if
    end repeat
  end tell
end tell
`;

  try {
    execFileSync("osascript", ["-e", script], { encoding: "utf8" });
  } catch {}
}

async function runCli(userData, args) {
  const parsed = cli.parseCli(args);
  const stdout = capture();
  const stderr = capture();
  const code = await cli.runClient(parsed, userData, {
    cwd: process.cwd(),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function waitForSocket(userData, appChild) {
  const socketPath = cli.getSocketPath(userData);
  for (let i = 0; i < 150; i += 1) {
    if (appChild.exitCode !== null) {
      throw new Error(`Grandicast exited early with code ${appChild.exitCode}`);
    }
    if (fs.existsSync(socketPath)) return;
    await sleep(100);
  }
  throw new Error("Timed out waiting for the Grandicast control socket");
}

async function findSource(grandi, needle, timeoutMs = 15000) {
  const finder = await grandi.find({ showLocalSources: true });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await finder.wait(500);
      const source = finder
        .sources()
        .find((entry) => entry.name.includes(needle));
      if (source) return source;
    }
  } finally {
    finder.destroy();
  }
  throw new Error(`NDI source not found: ${needle}`);
}

async function waitForFrame(receiver, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const frame = await receiver.video(Math.max(250, deadline - Date.now()));
      if (predicate(frame)) return frame;
    } catch {
      if (Date.now() >= deadline) break;
    }
  }
  throw new Error("Timed out waiting for a matching NDI video frame");
}

async function waitForNoFrames(receiver, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await receiver.video(750);
    } catch {
      return true;
    }
  }
  return false;
}

test(
  "real NDI stream reflects live CLI parameter changes",
  { timeout: 90000 },
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grandicast-e2e-"));
    const userData = path.join(tempDir, "profile");
    const pagePath = path.join(tempDir, "page.html");
    const configPath = path.join(tempDir, "config.json");

    fs.writeFileSync(
      pagePath,
      "<!doctype html><html><body style=\"background:#0b1020;color:#4ecca3;font:700 40px sans-serif;display:grid;place-items:center;height:100vh;margin:0\">GRANDICAST E2E</body></html>",
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify([
        {
          url: `file://${pagePath}`,
          width: 640,
          height: 360,
          hidden: false,
          ndi: {
            enabled: true,
            name: "Grandicast-E2E",
            fps: 30,
            audio: "off",
          },
        },
      ]),
    );

    let appChild = null;
    let receiver = null;
    let renamedReceiver = null;
    const appOutput = [];
    let grandi = null;

    try {
      appChild = spawn(
        electronPath,
        [
          root,
          "--panel",
          "--user-data-dir",
          userData,
          "--config",
          configPath,
        ],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      appChild.stdout.on("data", (chunk) => appOutput.push(chunk.toString()));
      appChild.stderr.on("data", (chunk) => appOutput.push(chunk.toString()));

      await waitForSocket(userData, appChild);
      await sleep(1200);
      positionWindowsRight();

      const listed = await runCli(userData, ["list", "--json"]);
      assert.equal(listed.code, 0, listed.stderr);
      const initialWindows = JSON.parse(listed.stdout).windows;
      assert.equal(initialWindows.length, 1);
      assert.equal(initialWindows[0].width, 640);
      assert.equal(initialWindows[0].height, 360);
      assert.equal(initialWindows[0].fps, 30);
      assert.equal(initialWindows[0].ndiActive, true);

      grandi = (await import("grandi")).default;
      grandi.initialize();

      const initialSource = await findSource(grandi, "Grandicast-E2E");
      receiver = await grandi.receive({ source: initialSource });
      const initialFrame = await waitForFrame(
        receiver,
        (frame) =>
          frame.xres === 640 &&
          frame.yres === 360 &&
          frame.frameRateN === 30 &&
          frame.frameRateD === 1,
      );
      assert.ok(initialFrame.data.length > 0);
      assert.ok(initialFrame.lineStrideBytes >= initialFrame.xres);

      const sizeUpdate = await runCli(userData, [
        "update",
        "1",
        "--width",
        "960",
        "--height",
        "540",
        "--fps",
        "60",
      ]);
      assert.equal(sizeUpdate.code, 0, sizeUpdate.stderr);
      assert.match(sizeUpdate.stdout, /Updated window 1/);

      const sizeChanged = await waitForFrame(
        receiver,
        (frame) =>
          frame.xres === 960 &&
          frame.yres === 540 &&
          frame.frameRateN === 60 &&
          frame.frameRateD === 1,
        12000,
      );
      assert.ok(sizeChanged.data.length > 0);
      assert.ok(sizeChanged.lineStrideBytes >= sizeChanged.xres);

      const afterUpdate = JSON.parse(
        (await runCli(userData, ["list", "--json"])).stdout,
      ).windows[0];
      assert.equal(afterUpdate.width, 960);
      assert.equal(afterUpdate.height, 540);
      assert.equal(afterUpdate.fps, 60);

      const rename = await runCli(userData, [
        "start",
        "1",
        "--name",
        "Grandicast-E2E-Renamed",
        "--fps",
        "24",
        "--audio",
        "off",
      ]);
      assert.equal(rename.code, 0, rename.stderr);
      assert.match(rename.stdout, /Grandicast-E2E-Renamed/);

      const renamedSource = await findSource(grandi, "Grandicast-E2E-Renamed");
      renamedReceiver = await grandi.receive({ source: renamedSource });
      const renamedFrame = await waitForFrame(
        renamedReceiver,
        (frame) =>
          frame.xres === 960 &&
          frame.yres === 540 &&
          frame.frameRateN === 24 &&
          frame.frameRateD === 1,
        12000,
      );
      assert.ok(renamedFrame.data.length > 0);
      assert.ok(renamedFrame.lineStrideBytes >= renamedFrame.xres);

      const afterRename = JSON.parse(
        (await runCli(userData, ["list", "--json"])).stdout,
      ).windows[0];
      assert.equal(afterRename.ndiName, "Grandicast-E2E-Renamed");
      assert.equal(afterRename.fps, 24);
      assert.equal(afterRename.audioPreset, "off");

      const stop = await runCli(userData, ["stop", "1"]);
      assert.equal(stop.code, 0, stop.stderr);
      assert.equal(await waitForNoFrames(renamedReceiver), true);

      const afterStop = JSON.parse(
        (await runCli(userData, ["list", "--json"])).stdout,
      ).windows[0];
      assert.equal(afterStop.ndiActive, false);
      assert.equal(afterStop.state, "running");

      const close = await runCli(userData, ["close", "1"]);
      assert.equal(close.code, 0, close.stderr);
      const afterClose = JSON.parse(
        (await runCli(userData, ["list", "--json"])).stdout,
      ).windows;
      assert.equal(afterClose.length, 0);

      const quit = await runCli(userData, ["quit"]);
      assert.equal(quit.code, 0, quit.stderr);

      await Promise.race([
        new Promise((resolve) => appChild.once("exit", resolve)),
        sleep(5000).then(() => {
          throw new Error("Grandicast did not exit after quit");
        }),
      ]);
    } catch (error) {
      error.message += `\n\nGrandicast output:\n${appOutput.join("")}`;
      throw error;
    } finally {
      if (receiver) {
        try {
          receiver.destroy();
        } catch {}
      }
      if (renamedReceiver) {
        try {
          renamedReceiver.destroy();
        } catch {}
      }
      if (grandi) {
        try {
          grandi.destroy();
        } catch {}
      }
      if (appChild && appChild.exitCode === null) {
        appChild.kill("SIGTERM");
        await sleep(500);
        if (appChild.exitCode === null) appChild.kill("SIGKILL");
      }
    }
  },
);

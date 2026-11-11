"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Writable } = require("node:stream");

const cli = require("../src/cli.cjs");
const pkg = require("../package.json");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grandicast-test-"));
}

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

async function run(args, userData, cwd = process.cwd()) {
  const parsed = cli.parseCli(args);
  const out = capture();
  const err = capture();
  const code = await cli.runClient(parsed, userData, {
    cwd,
    stdout: out.stream,
    stderr: err.stream,
  });
  return { code, stdout: out.text(), stderr: err.text(), parsed };
}

test("getArgv handles packaged and development arguments", () => {
  assert.deepEqual(cli.getArgv(["electron", "app", "list"], false), ["list"]);
  assert.deepEqual(cli.getArgv(["grandicast", "list"], true), ["list"]);
  assert.deepEqual(cli.getArgv(["electron", "app", "--", "add"], false), [
    "add",
  ]);
});

test("parseCli parses commands, aliases, and options", () => {
  assert.equal(cli.parseCli([]).command, null);
  assert.equal(cli.parseCli(["ls"]).command, "list");
  assert.equal(cli.parseCli(["status"]).command, "list");
  assert.equal(cli.parseCli(["rm", "2"]).command, "close");
  assert.equal(cli.parseCli(["start-ndi", "2"]).command, "start");

  const parsed = cli.parseCli([
    "add",
    "--url",
    "https://example.com",
    "--ndi",
    "--width",
    "640",
    "--height",
    "360",
    "--name",
    "Cam",
    "--fps",
    "60",
    "--audio",
    "high",
    "--hidden",
    "--transparent",
    "--frameless",
  ]);
  assert.equal(parsed.command, "add");
  assert.equal(parsed.options.url, "https://example.com");
  assert.equal(parsed.options.ndi, true);
  assert.equal(parsed.options.hidden, true);
});

test("parseCli rejects unknown commands and options", () => {
  assert.throws(() => cli.parseCli(["bogus"]), /Unknown command/);
  assert.throws(() => cli.parseCli(["list", "--bogus"]), /Unknown option/);
});

test("usage and version are populated", () => {
  assert.match(cli.usage(), /Grandicast/);
  assert.match(cli.usage(), /Commands:/);
  assert.match(cli.usage(), /--config/);
  assert.equal(cli.version(), pkg.version);
});

test("normalizeWindowConfig applies defaults", () => {
  assert.deepEqual(cli.normalizeWindowConfig({ url: "https://example.com" }), {
    url: "https://example.com",
    width: 1280,
    height: 720,
    transparent: false,
    frameless: false,
    hidden: false,
    title: "",
    ndi: {
      enabled: false,
      name: "",
      fps: 30,
      audio: "off",
    },
  });
});

test("normalizeWindowConfig supports boolean and object ndi config", () => {
  const boolNdi = cli.normalizeWindowConfig({
    url: "https://example.com",
    ndi: true,
  });
  assert.equal(boolNdi.ndi.enabled, true);
  assert.equal(boolNdi.ndi.audio, "balanced");

  const objectNdi = cli.normalizeWindowConfig({
    url: "https://example.com",
    ndi: { name: "Cam", fps: 60, audio: "high" },
  });
  assert.equal(objectNdi.ndi.enabled, true);
  assert.equal(objectNdi.ndi.name, "Cam");
  assert.equal(objectNdi.ndi.fps, 60);
  assert.equal(objectNdi.ndi.audio, "high");

  const disabled = cli.normalizeWindowConfig({
    url: "https://example.com",
    ndi: { enabled: false, name: "Idle" },
  });
  assert.equal(disabled.ndi.enabled, false);
  assert.equal(disabled.ndi.name, "Idle");
});

test("normalizeWindowConfig accepts flat settings fields", () => {
  const config = cli.normalizeWindowConfig({
    url: "https://example.com",
    width: 800,
    height: 450,
    ndiName: "Flat",
    fps: 24,
    audioPreset: "low",
    audioEnabled: false,
  });
  assert.equal(config.ndi.name, "Flat");
  assert.equal(config.ndi.fps, 24);
  assert.equal(config.ndi.audio, "low");
  assert.equal(config.ndi.enabled, false);
});

test("normalizeWindowConfig rejects invalid values", () => {
  assert.throws(() => cli.normalizeWindowConfig({ url: "" }), /url/);
  assert.throws(() => cli.normalizeWindowConfig({ url: "x", width: 0 }), /width/);
  assert.throws(
    () => cli.normalizeWindowConfig({ url: "x", height: -1 }),
    /height/,
  );
  assert.throws(() => cli.normalizeWindowConfig({ url: "x", fps: 0 }), /fps/);
  assert.throws(
    () => cli.normalizeWindowConfig({ url: "x", audio: "loud" }),
    /audio/,
  );
});

test("normalizeConfig accepts arrays, windows, and panels", () => {
  const one = [{ url: "https://a.test" }];
  const two = [{ url: "https://b.test" }];
  assert.equal(cli.normalizeConfig(one).length, 1);
  assert.equal(cli.normalizeConfig({ windows: two }).length, 1);
  assert.equal(cli.normalizeConfig({ panels: two }).length, 1);
  assert.throws(() => cli.normalizeConfig({}), /Config must be/);
});

test("loadConfig reads files, normalizes, and reports bad input", () => {
  const dir = tempDir();
  const file = path.join(dir, "sources.json");
  fs.writeFileSync(file, JSON.stringify([{ url: "https://file.test" }]));

  const loaded = cli.loadConfig(file, dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].url, "https://file.test");

  assert.throws(() => cli.loadConfig("missing.json", dir), /Failed to read/);

  fs.writeFileSync(file, "{ nope");
  assert.throws(() => cli.loadConfig(file, dir), /Invalid JSON/);

  fs.writeFileSync(file, JSON.stringify({}));
  assert.throws(() => cli.loadConfig(file, dir), /Config must be/);
});

test("loadConfig reads stdin with '-'", () => {
  const script = `
    const cli = require(${JSON.stringify(require.resolve("../src/cli.cjs"))});
    process.stdout.write(JSON.stringify(cli.loadConfig("-", process.cwd())));
  `;
  const output = execFileSync(process.execPath, ["-e", script], {
    input: JSON.stringify([{ url: "https://stdin.test", ndi: true }]),
    encoding: "utf8",
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed[0].url, "https://stdin.test");
  assert.equal(parsed[0].ndi.enabled, true);
});

test("buildRequest builds startup and command requests", () => {
  const dir = tempDir();
  const file = path.join(dir, "sources.json");
  fs.writeFileSync(file, JSON.stringify([{ url: "https://file.test" }]));

  const startup = cli.buildRequest(cli.parseCli(["--config", file]), dir);
  assert.equal(startup.command, "apply");
  assert.equal(startup.windows[0].url, "https://file.test");

  const forcedNdi = cli.buildRequest(
    cli.parseCli(["--config", file, "--ndi"]),
    dir,
  );
  assert.equal(forcedNdi.windows[0].ndi.enabled, true);

  assert.equal(cli.buildRequest(cli.parseCli([]), dir).command, "activate");
  assert.equal(
    cli.buildRequest(cli.parseCli(["--url", "https://x.test"]), dir).command,
    "add",
  );
  assert.equal(cli.buildRequest(cli.parseCli(["list"]), dir).command, "list");

  const add = cli.buildRequest(
    cli.parseCli(["add", "--url", "https://x.test", "--ndi"]),
    dir,
  );
  assert.equal(add.window.ndi.enabled, true);
  assert.equal(add.window.ndi.audio, "balanced");

  const update = cli.buildRequest(
    cli.parseCli(["update", "2", "--width", "800", "--audio", "low"]),
    dir,
  );
  assert.equal(update.target, "2");
  assert.equal(update.patch.width, 800);
  assert.equal(update.patch.audioPreset, "low");

  assert.equal(
    cli.buildRequest(cli.parseCli(["reload", "3"]), dir).target,
    "3",
  );
  assert.equal(
    cli.buildRequest(cli.parseCli(["start", "3", "--fps", "60"]), dir).options
      .fps,
    60,
  );
  assert.equal(
    cli.buildRequest(cli.parseCli(["stop", "--all"]), dir).all,
    true,
  );
  assert.equal(
    cli.buildRequest(cli.parseCli(["close", "3"]), dir).target,
    "3",
  );
  assert.equal(cli.buildRequest(cli.parseCli(["quit"]), dir).command, "quit");
});

test("buildRequest validates missing and invalid command input", () => {
  assert.throws(() => cli.buildRequest(cli.parseCli(["apply"]), process.cwd()), /apply requires/);
  assert.throws(() => cli.buildRequest(cli.parseCli(["update"]), process.cwd()), /requires a window/);
  assert.throws(
    () => cli.buildRequest(cli.parseCli(["add"]), process.cwd()),
    /add requires --url/,
  );
  assert.throws(
    () => cli.buildRequest(cli.parseCli(["update", "1"]), process.cwd()),
    /at least one option/,
  );
  assert.throws(
    () => cli.buildRequest(cli.parseCli(["start", "1", "--audio", "bad"]), process.cwd()),
    /audio/,
  );
});

test("getSocketPath is deterministic and profile-specific", () => {
  const a = cli.getSocketPath("/tmp/profile-a");
  const b = cli.getSocketPath("/tmp/profile-a");
  const c = cli.getSocketPath("/tmp/profile-b");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /grandicast-/);
});

test("runClient sends commands, prints human output, and handles errors", async () => {
  const dir = tempDir();
  const configFile = path.join(dir, "apply.json");
  fs.writeFileSync(configFile, "[]");
  const socketPath = cli.getSocketPath(dir);
  const requests = [];
  const server = await cli.startControlServer(socketPath, async (request) => {
    requests.push(request);
    if (request.command === "list") {
      return {
        windows: [
          {
            id: 1,
            url: "https://one.test",
            width: 1280,
            height: 720,
            ndiActive: true,
            ndiName: "One",
            fps: 30,
            audioPreset: "off",
            state: "ndi",
          },
        ],
      };
    }
    if (request.command === "add") {
      return {
        windows: [
          {
            id: 2,
            url: request.window.url,
            width: 1280,
            height: 720,
            ndiActive: true,
            ndiName: "Two",
            fps: 30,
            audioPreset: "balanced",
            state: "ndi",
          },
        ],
      };
    }
    if (request.command === "update") {
      return { id: 2, url: "https://two.test" };
    }
    if (request.command === "start") {
      return { id: 2, ndiName: "Cam", fps: 60, audioPreset: "high" };
    }
    if (request.command === "stop") return { id: 2 };
    if (request.command === "close") return { ids: [1, 2] };
    if (request.command === "reload") return { id: 2 };
    if (request.command === "quit") return { quitting: true };
    if (request.command === "apply") {
      return { windows: [] };
    }
    throw new Error("bad command");
  });

  try {
    let result = await run(["list"], dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /ID\s+STATE/);
    assert.match(result.stdout, /One/);

    result = await run(["list", "--json"], dir);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).windows[0].id, 1);

    result = await run(["add", "--url", "https://two.test", "--ndi"], dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Created window 2/);
    assert.match(result.stdout, /NDI started as "Two"/);

    result = await run(["update", "2", "--width", "800"], dir);
    assert.match(result.stdout, /Updated window 2/);

    result = await run(["start", "2", "--name", "Cam", "--fps", "60"], dir);
    assert.match(result.stdout, /NDI started for window 2 as "Cam"/);

    result = await run(["stop", "2"], dir);
    assert.match(result.stdout, /NDI stopped for window 2/);

    result = await run(["reload", "2"], dir);
    assert.match(result.stdout, /Reloaded window 2/);

    result = await run(["close", "--all"], dir);
    assert.match(result.stdout, /Closed 2 window/);

    result = await run(["apply", "--config", configFile], dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Applied config: 0 window/);

    result = await run(["quit"], dir);
    assert.match(result.stdout, /Grandicast quitting/);

    assert.equal(requests.length, 10);
  } finally {
    await server.close();
  }
});

test("runClient reports server-side errors", async () => {
  const dir = tempDir();
  const server = await cli.startControlServer(
    cli.getSocketPath(dir),
    async () => {
      throw new Error("No such window");
    },
  );

  try {
    const result = await run(["stop", "99"], dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No such window/);
  } finally {
    await server.close();
  }
});

test("runClient reports invalid config before connecting", async () => {
  const dir = tempDir();
  const result = await run(["apply", "--config", "missing.json"], dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Failed to read config/);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("main process command dispatcher handles every CLI command", () => {
  const harness = path.join(__dirname, "fixtures/main-harness.cjs");
  const output = execFileSync(process.execPath, [harness], {
    encoding: "utf8",
    timeout: 20000,
  });

  const result = JSON.parse(output);
  const results = result.results;

  assert.equal(results.length, 9);

  assert.equal(results[0].code, 0);
  assert.equal(JSON.parse(results[0].stdout).windows.length, 1);
  assert.equal(
    JSON.parse(results[0].stdout).windows[0].url,
    "https://startup.test",
  );

  assert.equal(results[1].code, 0);
  assert.match(results[1].stdout, /Created window 2/);
  assert.match(results[1].stdout, /NDI started as "AddedCam"/);

  assert.equal(results[2].code, 0);
  assert.match(results[2].stdout, /Updated window 2/);

  assert.equal(results[3].code, 0);
  assert.match(results[3].stdout, /NDI stopped for window 2/);

  assert.equal(results[4].code, 0);
  assert.match(results[4].stdout, /Applied config: 1 window/);

  assert.equal(results[5].code, 0);
  const afterMerge = JSON.parse(results[5].stdout).windows;
  assert.equal(afterMerge.length, 3);
  assert.ok(afterMerge.some((w) => w.url === "https://merge.test"));
  assert.ok(afterMerge.some((w) => w.ndiName === "MergeCam"));

  assert.equal(results[6].code, 0);
  assert.match(results[6].stdout, /Closed 3 window/);

  assert.equal(results[7].code, 0);
  assert.equal(JSON.parse(results[7].stdout).windows.length, 0);

  assert.equal(results[8].code, 0);
  assert.match(results[8].stdout, /Grandicast quitting/);

  assert.deepEqual(result.sentNdi, [
    "AddedCam",
    "RenamedCam",
    "MergeCam",
  ]);
  assert.equal(result.appQuit, true);
  assert.equal(result.appExit, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerReviewPane, runHerdr } from "../src/herdr.mjs";

const pluginEnv = { HERDR_ENV: "1", HERDR_PLUGIN_ID: "vflo.review", HERDR_PLUGIN_ENTRYPOINT_ID: "review" };

test("real command runner accepts silent lifecycle acknowledgements but requires JSON for queries", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-herdr-cli-test-"));
  const binary = path.join(dir, "herdr-fixture.mjs");
  const previous = process.env.HERDR_BIN_PATH;
  t.after(async () => {
    if (previous === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  });
  // Exercise execFile and registerReviewPane together. The old mocks returned
  // JSON for every command, hiding Herdr's deliberately silent hook replies.
  await writeFile(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--fail')) process.exit(1);
if (args[0] === 'pane' && args[1] === 'current') process.stdout.write(JSON.stringify({ result: { pane: { pane_id: 'w2:p9', tab_id: 'w2:t3' } } }));
else if (args[0] === 'tab' && args[1] === 'rename') process.stdout.write(JSON.stringify({ result: {} }));
`);
  await chmod(binary, 0o700);
  process.env.HERDR_BIN_PATH = binary;
  const registration = await registerReviewPane({ env: pluginEnv });
  await registration.close();
  await assert.rejects(runHerdr(['pane', 'get', 'w2:p9']), /returned no JSON/);
  await assert.rejects(runHerdr(['pane', 'report-agent', '--fail'], { allowEmpty: true }));
});

test("review publishes a visible sidebar title without renaming the conversation, then cleans up once", async () => {
  const calls = [];
  const registration = await registerReviewPane({ env: pluginEnv, run: async (args) => {
    calls.push(args);
    return { pane: { pane_id: "w2:p9", tab_id: "w2:t3" } };
  } });
  assert.deepEqual(calls, [
    ["pane", "current", "--current"],
    ["pane", "report-agent", "w2:p9", "--source", "vflo.review", "--agent", "review", "--state", "idle"],
    ["pane", "report-metadata", "w2:p9", "--source", "vflo.review", "--agent", "review", "--applies-to-source", "vflo.review", "--title", "review", "--display-agent", "review"],
  ]);
  await Promise.all([registration.close(), registration.close()]);
  assert.deepEqual(calls.slice(3), [
    ["pane", "report-metadata", "w2:p9", "--source", "vflo.review", "--agent", "review", "--applies-to-source", "vflo.review", "--clear-title", "--clear-display-agent"],
    ["pane", "release-agent", "w2:p9", "--source", "vflo.review", "--agent", "review"],
  ]);
});

test("registration and cleanup do not overwrite another sidebar plugin\'s title tokens", async () => {
  // Herdr token keys are shared across sources. Radar rewrites title_idle on
  // every frame; direct writes only appear briefly, then vanish or conflict.
  const tokens = { title_idle: "radar-owned title" };
  const registration = await registerReviewPane({ env: pluginEnv, run: async (args) => {
    if (args[1] === "report-metadata") {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--token") {
          const equal = args[i + 1].indexOf("=");
          tokens[args[i + 1].slice(0, equal)] = args[i + 1].slice(equal + 1);
        }
        if (args[i] === "--clear-token") delete tokens[args[i + 1]];
      }
    }
    return { pane: { pane_id: "w2:p9" } };
  } });
  try { assert.equal(tokens.title_idle, "radar-owned title"); }
  finally { await registration.close(); }
  assert.equal(tokens.title_idle, "radar-owned title", "cleanup must not erase another writer\'s token");
});

test("metadata startup or cleanup failures still release lifecycle authority", async () => {
  for (const failingFlag of ["--title", "--clear-title"]) {
    const calls = [];
    const run = async (args) => {
      calls.push(args);
      if (args.includes(failingFlag)) throw new Error("metadata failure");
      return { pane: { pane_id: "w2:p9" } };
    };
    if (failingFlag === "--title") {
      await assert.rejects(registerReviewPane({ env: pluginEnv, run }), /metadata failure/);
    } else {
      const registration = await registerReviewPane({ env: pluginEnv, run });
      await assert.rejects(registration.close(), /metadata failure/);
    }
    assert.equal(calls.filter((args) => args[1] === "release-agent").length, 1);
  }
});

test("direct launches never relabel the inherited Pi pane", async () => {
  const run = async () => { assert.fail("Must not call Herdr outside this plugin's context"); };
  for (const env of [{}, { HERDR_ENV: "1", HERDR_PANE_ID: "main-pi" }, { ...pluginEnv, HERDR_PLUGIN_ID: "another.plugin" }]) {
    const registration = await registerReviewPane({ env, run });
    await registration.close();
  }
});

test("missing pane identity does not leave lifecycle authority behind", async () => {
  const calls = [];
  await assert.rejects(registerReviewPane({ env: pluginEnv, run: async (args) => {
    calls.push(args);
    return { pane: { tab_id: "t" } };
  } }), /identify the review pane/);
  assert.equal(calls.some((args) => args[1] === "report-agent"), false);
});

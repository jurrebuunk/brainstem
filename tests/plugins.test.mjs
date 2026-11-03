import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  PluginNotFoundError,
  legacyBuiltinPackage,
  loadDestinationPlugin,
  loadInputPlugin,
  resolvePluginModuleUrl
} from "../src/runtime/plugin-loader.mjs";
import { runCli } from "../src/cli/index.mjs";
import { MemoryPluginStateStore, defineDestinationPlugin, defineInputPlugin } from "@brainstem-dev/sdk";
import { createTestOutput, runDestination, runInput } from "@brainstem-dev/sdk/testing";
import { tempDir } from "./helpers/fixtures.mjs";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

/*
 * A plugin package in <dir>/node_modules/<name>.
 */
async function writePackage(dir, name, { manifest = {}, files = {} } = {}) {
  const packageDir = join(dir, "node_modules", ...name.split("/"));
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name, version: "1.2.3", type: "module", ...manifest }));
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(packageDir, file, ".."), { recursive: true });
    await writeFile(join(packageDir, file), source);
  }
  return packageDir;
}

const inputSource = name => `export default {
  apiVersion: "brainstem.input/v1",
  name: ${JSON.stringify(name)},
  inputs: { default: { mode: "poll", async *poll() {} } }
};`;

// Loader.

test("plugins load by package name from the plugin folder, honouring exports and main", async () => {
  const dir = await tempDir("plugin-folder");
  const env = { BRAINSTEM_PLUGINS_DIR: dir };

  await writePackage(dir, "brainstem-plugin-exports-string", { manifest: { exports: "./lib/plugin.mjs" }, files: { "lib/plugin.mjs": inputSource("a") } });
  await writePackage(dir, "@acme/brainstem-conditional", {
    manifest: { exports: { ".": { types: "./x.d.ts", import: "./esm.mjs", require: "./cjs.cjs" } } },
    files: { "esm.mjs": inputSource("b") }
  });
  await writePackage(dir, "brainstem-plugin-main", { manifest: { main: "entry.mjs" }, files: { "entry.mjs": inputSource("c") } });
  await writePackage(dir, "brainstem-plugin-subpath", { manifest: { exports: { ".": "./a.mjs", "./extra": "./extra.mjs" } }, files: { "extra.mjs": inputSource("d") } });

  for (const [specifier, name] of [
    ["brainstem-plugin-exports-string", "a"],
    ["@acme/brainstem-conditional", "b"],
    ["brainstem-plugin-main", "c"],
    ["brainstem-plugin-subpath/extra", "d"]
  ]) {
    const { plugin } = await loadInputPlugin(specifier, { baseDir: dir, env });
    assert.equal(plugin.name, name, specifier);
  }
});

test("the plugin folder wins over Brainstem's own copy of a built-in", async () => {
  const dir = await tempDir("plugin-override");
  await writePackage(dir, "@brainstem-dev/plugin-log-decisions", {
    manifest: { exports: "./index.mjs" },
    files: { "index.mjs": `export default { apiVersion: "brainstem.destination/v2", name: "patched-log", destinations: { default: { async handle() {} } } };` }
  });

  const { plugin } = await loadDestinationPlugin("@brainstem-dev/plugin-log-decisions", { baseDir: dir, env: { BRAINSTEM_PLUGINS_DIR: dir } });
  assert.equal(plugin.name, "patched-log");
});

test("built-ins resolve by name from Brainstem itself, and their 1.x paths keep working", async () => {
  const elsewhere = await tempDir("no-plugins-here");
  const env = { BRAINSTEM_PLUGINS_DIR: join(elsewhere, "empty") };

  const { plugin } = await loadDestinationPlugin("@brainstem-dev/plugin-log-decisions", { baseDir: elsewhere, env });
  assert.equal(plugin.name, "@brainstem/log-decisions");

  assert.equal(legacyBuiltinPackage("./plugins/matrix/index.mjs"), "@brainstem-dev/plugin-matrix");
  assert.equal(legacyBuiltinPackage("./plugins/my-own/index.mjs"), null);
  const legacy = await loadDestinationPlugin("./plugins/matrix/index.mjs", { baseDir: elsewhere, env });
  assert.equal(legacy.plugin.name, "@brainstem/matrix");

  // A local file at that path still wins.
  await mkdir(join(elsewhere, "plugins", "matrix"), { recursive: true });
  await writeFile(join(elsewhere, "plugins", "matrix", "index.mjs"), `export default { apiVersion: "brainstem.destination/v2", name: "local-matrix", destinations: { default: { async handle() {} } } };`);
  const local = await loadDestinationPlugin("./plugins/matrix/index.mjs", { baseDir: elsewhere, env });
  assert.equal(local.plugin.name, "local-matrix");
});

test("a missing package says how to install it", async () => {
  const dir = await tempDir("plugin-missing");
  assert.throws(
    () => resolvePluginModuleUrl("brainstem-plugin-nope", { baseDir: dir, env: { BRAINSTEM_PLUGINS_DIR: dir } }),
    error => error instanceof PluginNotFoundError && /brainstem plugins add brainstem-plugin-nope/.test(error.message)
  );
  assert.throws(() => resolvePluginModuleUrl("", {}), /non-empty string/);
});

// CLI.

test("brainstem init --no-defaults creates the config and the plugin folder", async () => {
  const dir = await tempDir("init");
  const io = { lines: [], errors: [], out(line) { this.lines.push(line); }, err(line) { this.errors.push(line); } };

  const code = await runCli(["init", "--no-defaults", "--plugins-dir", join(dir, "plugins"), "--config", join(dir, "brainstem.config.mjs")], io);

  assert.equal(code, 0, io.errors.join("\n"));
  assert.ok(existsSync(join(dir, "brainstem.config.mjs")));
  const manifest = JSON.parse(await readFile(join(dir, "plugins", "package.json"), "utf8"));
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies, {});

  // Running it again keeps the existing config.
  await runCli(["init", "--no-defaults", "--plugins-dir", join(dir, "plugins"), "--config", join(dir, "brainstem.config.mjs")], io);
  assert.match(io.lines.join("\n"), /Keeping .*brainstem\.config\.mjs/);
});

test("brainstem plugins add, list and remove manage npm packages in the plugin folder", { timeout: 120_000 }, async () => {
  const dir = await tempDir("plugins-cli");
  const tarballs = join(dir, "tarballs");
  const folder = join(dir, "plugins");
  await mkdir(tarballs);

  // Packed like they are published.
  await run("npm", ["pack", "--silent", "--pack-destination", tarballs, "--workspace", "@brainstem-dev/sdk", "--workspace", "@brainstem-dev/plugin-static-observations"], { cwd: ROOT });
  const io = { lines: [], errors: [], out(line) { this.lines.push(line); }, err(line) { this.errors.push(line); } };
  const cli = args => runCli([...args, "--plugins-dir", folder], io);

  const previous = process.env.npm_config_offline;
  process.env.npm_config_offline = "true";

  try {
    assert.equal(await cli(["plugins", "add",
      join(tarballs, `brainstem-dev-sdk-${VERSION}.tgz`),
      join(tarballs, `brainstem-dev-plugin-static-observations-${VERSION}.tgz`)
    ]), 0, io.errors.join("\n"));
    assert.match(io.lines.join("\n"), new RegExp(`Installed @brainstem-dev/plugin-static-observations@${VERSION.replaceAll(".", "\\.")}: input plugin`));

    io.lines.length = 0;
    assert.equal(await cli(["plugins", "list"]), 0);
    assert.match(io.lines.join("\n"), new RegExp(`@brainstem-dev/plugin-static-observations\\s+${VERSION.replaceAll(".", "\\.")}\\s+input\\s+plugin folder`));

    // The runtime loads it from the folder.
    const { plugin } = await loadInputPlugin("@brainstem-dev/plugin-static-observations", { baseDir: dir, env: { BRAINSTEM_PLUGINS_DIR: folder } });
    assert.equal(plugin.name, "@brainstem/static-observations");

    assert.equal(await cli(["plugins", "remove", "static-observations"]), 0, io.errors.join("\n"));
    const manifest = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
    assert.equal(manifest.dependencies?.["@brainstem-dev/plugin-static-observations"], undefined);
  }
  finally {
    if (previous === undefined) delete process.env.npm_config_offline;
    else process.env.npm_config_offline = previous;
  }
});

test("plugins add rejects a package that is not a Brainstem plugin", { timeout: 60_000 }, async () => {
  const dir = await tempDir("plugins-not-a-plugin");
  const source = join(dir, "not-a-plugin");
  await mkdir(source);
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "not-a-plugin", version: "1.0.0", type: "module", main: "index.mjs" }));
  await writeFile(join(source, "index.mjs"), "export default { hello: 'world' };");

  const io = { lines: [], errors: [], out(line) { this.lines.push(line); }, err(line) { this.errors.push(line); } };
  const code = await runCli(["plugins", "add", source, "--plugins-dir", join(dir, "plugins")], io);

  assert.equal(code, 1);
  assert.match(io.errors.join("\n"), /not-a-plugin is not a Brainstem plugin/);
  assert.match(io.errors.join("\n"), /Uninstalled again: not-a-plugin/);
  const manifest = JSON.parse(await readFile(join(dir, "plugins", "package.json"), "utf8"));
  assert.equal(manifest.dependencies?.["not-a-plugin"], undefined, "rolled back");
});

// SDK test kit.

test("the SDK test kit runs an input like the runtime: observations, checkpoint, state", async () => {
  const plugin = defineInputPlugin({
    apiVersion: "brainstem.input/v1",
    name: "counter",
    inputs: {
      default: {
        mode: "poll",
        async *poll(ctx) {
          const count = (await ctx.checkpoint.get())?.count ?? 0;
          await ctx.state.update("polls", polls => (polls ?? 0) + 1);
          ctx.logger.info("polling", { count });
          yield ctx.observation({ id: `n:${count}`, source: { type: "t", name: "t" }, type: "item", state: "new", title: `n ${count}`, message: "m" });
          ctx.checkpoint.defer({ count: count + 1 });
        }
      }
    }
  });

  const state = new MemoryPluginStateStore();
  const first = await runInput(plugin, { state });
  const second = await runInput(plugin, { state, checkpoint: first.checkpoint });

  assert.equal(first.observations[0].payload.id, "n:0");
  assert.equal(second.observations[0].payload.id, "n:1");
  assert.deepEqual(second.checkpoint, { count: 2 });
  assert.equal(await state.get("input:counter:default:default", "polls"), 2);
  assert.equal(first.logs[0].message, "polling");

  const broken = defineInputPlugin({
    apiVersion: "brainstem.input/v1",
    name: "broken",
    inputs: { default: { mode: "poll", async *poll(ctx) { yield ctx.observation({ id: "x" }); } } }
  });
  await assert.rejects(runInput(broken), /invalid payload\.source/);
});

test("the SDK test kit runs a destination with an output envelope, key and emit", async () => {
  const seen = [];
  const plugin = defineDestinationPlugin({
    apiVersion: "brainstem.destination/v2",
    name: "recorder",
    destinations: {
      default: {
        async handle(ctx, output) {
          seen.push({ key: ctx.idempotencyKey, decision: output.payload.decision.payload.decision, title: output.payload.observation.payload.title });
          ctx.emit(ctx.config.report
            ? { version: "1", kind: "observation", payload: { id: "r:1", source: { type: "t", name: "t" }, type: "report", state: "done", timestamp: new Date().toISOString(), title: "Report", message: "ok" } }
            : null);
        }
      }
    }
  });

  const output = createTestOutput({ observation: { title: "Disk full" }, decision: "escalate", idempotencyKey: "k-1" });
  const { emitted } = await runDestination(plugin, output, { config: { report: true } });

  assert.deepEqual(seen, [{ key: "k-1", decision: "escalate", title: "Disk full" }]);
  assert.equal(emitted[0].payload.type, "report");
  await assert.rejects(runDestination(plugin, output, { config: { report: false } }), /non-object observation/);
});

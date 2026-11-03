#!/usr/bin/env node
/*
 * npm packaging smoke test: what a user does after `npm publish`.
 *
 *   node scripts/npm-smoke.mjs
 *
 * Starts a throwaway local registry (Verdaccio), publishes every
 * workspace package to it, then, in an empty prefix and project:
 *
 *   npm install -g @brainstem-dev/brainstem
 *   brainstem init                      (installs the default plugins)
 *   brainstem plugins remove / add      (a default out, an optional one in)
 *   brainstem --once                    (polls an installed input plugin)
 *
 * Nothing touches the real npm registry except proxied third-party
 * dependencies. Exits non-zero on the first failure.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.NPM_SMOKE_PORT ?? 14874);
const REGISTRY = `http://127.0.0.1:${PORT}/`;
const work = await mkdtemp(join(tmpdir(), "brainstem-npm-smoke-"));
const version = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;

let registry;

try {
  registry = await startRegistry();
  const userconfig = await registryUser();

  step("publish every package");
  await sh("npm", ["publish", "--workspaces", "--include-workspace-root", "--ignore-scripts", "--userconfig", userconfig, "--registry", REGISTRY], { cwd: ROOT });

  const prefix = join(work, "prefix");
  const project = join(work, "project");
  await mkdir(project, { recursive: true });
  const env = {
    ...process.env,
    npm_config_registry: REGISTRY,
    npm_config_prefix: prefix,
    npm_config_cache: join(work, "cache"),
    npm_config_update_notifier: "false",
    PATH: `${join(prefix, "bin")}:${process.env.PATH}`,
    BRAINSTEM_PLUGINS_DIR: ""
  };

  step("npm install -g @brainstem-dev/brainstem");
  await sh("npm", ["install", "-g", `@brainstem-dev/brainstem@${version}`], { cwd: project, env });

  step("brainstem init");
  await sh("brainstem", ["init"], { cwd: project, env });
  let listing = await sh("brainstem", ["plugins", "list"], { cwd: project, env, capture: true });
  for (const name of ["http-health", "matrix", "static-observations", "log-decisions"]) {
    expect(listing.includes(`@brainstem-dev/plugin-${name} `), `default plugin ${name} is installed`);
  }
  expect(!listing.includes("built in"), "a global install ships no plugins of its own");

  step("brainstem plugins remove matrix, add email-imap");
  await sh("brainstem", ["plugins", "remove", "matrix"], { cwd: project, env });
  await sh("brainstem", ["plugins", "add", "email-imap"], { cwd: project, env });
  listing = await sh("brainstem", ["plugins", "list"], { cwd: project, env, capture: true });
  expect(!listing.includes("plugin-matrix"), "matrix is gone");
  expect(listing.includes("@brainstem-dev/plugin-email-imap "), "email-imap is installed");

  step("brainstem --once with installed plugins");
  await writeFile(join(project, "brainstem.config.mjs"), `export default {
  inputs: [{
    id: "smoke",
    module: "@brainstem-dev/plugin-static-observations",
    config: { observations: [{ id: "smoke:1", source: { type: "smoke", name: "npm" }, type: "item", state: "new", title: "Smoke", message: "From an npm install" }] }
  }],
  destinations: [{ id: "log", module: "@brainstem-dev/plugin-log-decisions", decisions: "all" }],
  // Poll and deliver only: no model download in CI.
  runtime: { queues: ["poll", "deliver"], logging: { level: "info", format: "json" } },
  policy: { dispatch: { attention: 0.65, actionable: 0.6 }, queue: { actionable: 0.5, severity: 1.25 }, actionableQueue: { actionable: 0.65 } },
  laya: { questions: {} }
};
`);
  const output = await sh("brainstem", ["--once"], { cwd: project, env, capture: true });
  expect(output.includes("\"input poll completed\"") && output.includes("\"observations\":1"), "the installed input plugin polled one observation");

  step("brainstem --role web serves the Web UI");
  const web = spawn("brainstem", ["--role", "web"], { cwd: project, env: { ...env, HOST: "127.0.0.1", PORT: String(PORT + 1) }, stdio: "ignore" });
  try {
    let page = "";
    for (let attempt = 0; attempt < 40 && !page.includes("<div id=\"root\""); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 250));
      page = await fetch(`http://127.0.0.1:${PORT + 1}/`).then(response => response.text()).catch(() => "");
    }
    expect(page.includes("<div id=\"root\""), "the packaged Web UI is served");
  }
  finally {
    web.kill("SIGTERM");
  }

  console.log("\nnpm smoke test passed");
}
catch (error) {
  console.error(`\nnpm smoke test FAILED: ${error.message}`);
  process.exitCode = 1;
}
finally {
  registry?.kill("SIGTERM");
}

async function startRegistry() {
  step(`start a local registry on ${REGISTRY}`);
  const dir = join(work, "registry");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yaml"), `storage: ${join(dir, "storage")}
auth:
  htpasswd:
    file: ${join(dir, "htpasswd")}
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@brainstem-dev/*':
    access: $all
    publish: $all
  '**':
    access: $all
    publish: $all
    proxy: npmjs
listen: 127.0.0.1:${PORT}
log: { type: stdout, format: pretty, level: error }
`);

  const child = spawn("npx", ["--yes", "verdaccio@6", "--config", join(dir, "config.yaml")], { stdio: ["ignore", "inherit", "inherit"] });

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${REGISTRY}-/ping`)).ok) return child;
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  child.kill();
  throw new Error("the local registry did not start");
}

// A throwaway user on the throwaway registry, in its own npmrc.
async function registryUser() {
  const password = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const response = await fetch(`${REGISTRY}-/user/org.couchdb.user:smoke`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "smoke", password })
  });
  const { token } = await response.json();
  const path = join(work, ".npmrc");
  await writeFile(path, `//127.0.0.1:${PORT}/:_authToken=${token}\n`);
  return path;
}

function sh(command, args, { cwd, env = process.env, capture = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"] });
    let output = "";
    if (capture) {
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
    }
    child.on("error", reject);
    child.on("close", code => {
      if (capture) process.stdout.write(output);
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function step(message) {
  console.log(`\n▶ ${message}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(`expected: ${message}`);
  console.log(`  ✔ ${message}`);
}

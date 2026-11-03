#!/usr/bin/env node
/*
 * Publish every package of this repository to npm, in dependency
 * order: @brainstem-dev/sdk, the plugins, then @brainstem-dev/brainstem.
 *
 *   node scripts/npm-publish.mjs [--dry-run] [--tag next]
 *
 * All packages share one version (lockstep), which must match the
 * release tag when GITHUB_REF_NAME is set. Versions already on the
 * registry are skipped, so a re-run after a partial failure finishes
 * the job. Adds --provenance in GitHub Actions.
 */
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const distTag = args.includes("--tag") ? args[args.indexOf("--tag") + 1] : null;

const root = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const workspaces = [];

for (const base of ["packages", "plugins"]) {
  for (const entry of (await readdir(join(ROOT, base), { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(ROOT, base, entry.name);
    workspaces.push({ dir, manifest: JSON.parse(await readFile(join(dir, "package.json"), "utf8")) });
  }
}

const packages = [...workspaces, { dir: ROOT, manifest: root }];
const version = root.version;
const tag = process.env.GITHUB_REF_NAME;

if (tag && tag.startsWith("v") && tag !== `v${version}`) {
  fail(`tag ${tag} does not match package version ${version}`);
}

for (const { manifest } of packages) {
  if (manifest.version !== version) fail(`${manifest.name} is ${manifest.version}, expected ${version} (all packages share one version)`);
}
if (root.dependencies?.["@brainstem-dev/sdk"] !== version) {
  fail(`@brainstem-dev/brainstem depends on @brainstem-dev/sdk ${root.dependencies?.["@brainstem-dev/sdk"]}, expected ${version}`);
}

const prerelease = version.includes("-");
const flags = [
  "--access", "public",
  ...(process.env.GITHUB_ACTIONS ? ["--provenance"] : []),
  ...(distTag ? ["--tag", distTag] : prerelease ? ["--tag", "next"] : []),
  ...(dryRun ? ["--dry-run"] : [])
];

let published = 0;

for (const { dir, manifest } of packages) {
  if (await exists(manifest.name, version)) {
    console.log(`skip ${manifest.name}@${version} (already published)`);
    continue;
  }

  console.log(`publish ${manifest.name}@${version}${dryRun ? " (dry run)" : ""}`);
  try {
    const { stdout, stderr } = await run("npm", ["publish", ...flags, "--ignore-scripts"], { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(stdout);
    process.stderr.write(stderr.split("\n").filter(line => !line.startsWith("npm notice")).join("\n"));
    published += 1;
  }
  catch (error) {
    process.stderr.write(error.stderr ?? "");
    fail(`publishing ${manifest.name} failed`);
  }
}

console.log(`\n${published} published, ${packages.length - published} skipped (version ${version}).`);

async function exists(name, version) {
  try {
    await run("npm", ["view", `${name}@${version}`, "version"]);
    return true;
  }
  catch {
    return false;
  }
}

function fail(message) {
  console.error(`npm-publish: ${message}`);
  process.exit(1);
}

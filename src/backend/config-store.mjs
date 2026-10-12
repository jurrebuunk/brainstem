import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createConfigStore(configPath) {
  return {
    async read() {
      return {
        path: configPath,
        content: await readFile(configPath, "utf8")
      };
    },

    async save(content) {
      await assertValidModule(content);
      await writeFileAtomic(configPath, content);

      return {
        ok: true,
        path: configPath,
        savedAt: new Date().toISOString()
      };
    }
  };
}

async function writeFileAtomic(path, content) {
  const directory = dirname(path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.${stamp}.bak`;
  const temporary = join(directory, `.${stamp}.${Math.random().toString(16).slice(2)}.tmp`);

  if (existsSync(path)) {
    await copyFile(path, backup);
  }

  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  }
  catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function assertValidModule(content) {
  const dir = await mkdtemp(join(tmpdir(), "brainstem-config-"));
  const file = join(dir, "brainstem.config.mjs");

  try {
    await writeFile(file, content, "utf8");
    await execFileAsync(process.execPath, ["--check", file], {
      timeout: 10_000
    });
  }
  catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    throw new Error(`Config syntax check failed: ${detail.trim()}`);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
}

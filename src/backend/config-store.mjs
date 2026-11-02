import { readFile } from "node:fs/promises";

/*
 * Read-only view of a config file (configSource "file").
 *
 * The API never writes or executes config files (ADR-0005): edit the
 * file and restart, or store the config in the database with
 * `brainstem config import` and edit versions through the API.
 */
export function createConfigStore(configPath) {
  return {
    async read() {
      return {
        path: configPath,
        content: await readFile(configPath, "utf8")
      };
    }
  };
}

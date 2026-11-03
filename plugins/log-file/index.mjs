import { open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { defineInputPlugin } from "@brainstem-dev/sdk";

/*
 * Watches a log file and emits one observation per poll that
 * finds new matching lines.
 *
 * Only complete lines after the checkpointed byte offset are
 * read, so a line is never matched twice. All matches from one
 * poll are folded into a single, size-capped observation: a
 * noisy log produces one bounded event, not hundreds.
 */
const DEFAULT_PATTERN = "\\b(ERROR|FATAL|CRITICAL|PANIC)\\b";

export default defineInputPlugin({
  apiVersion: "brainstem.input/v1",
  name: "@brainstem/log-file",

  inputs: {
    lines: {
      mode: "poll",
      defaultIntervalMs: 30_000,

      async *poll(ctx) {
        const config = normalizeConfig(ctx.config);
        const checkpoint = await ctx.checkpoint.get();
        const file = await stat(config.path).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });

        if (!file) {
          ctx.logger.warn?.("log file not found", { path: config.path });
          return;
        }

        // First poll: by default start at the end, so an existing
        // log is not replayed as a burst of old errors.
        if (!checkpoint && config.startFromEnd) {
          ctx.checkpoint.defer({ offset: file.size, ino: file.ino });
          ctx.logger.info?.("log file watch started at end of file", { path: config.path, offset: file.size });
          return;
        }

        let offset = checkpoint?.offset ?? 0;

        // Truncated or replaced (rotation): start over.
        if (
          offset > file.size ||
          (checkpoint?.ino !== undefined && checkpoint.ino !== file.ino)
        ) {
          ctx.logger.info?.("log file was truncated or rotated; reading from the start", { path: config.path });
          offset = 0;
        }

        const { text, nextOffset } = await readCompleteLines(
          config.path,
          offset,
          Math.min(file.size - offset, config.maxReadBytes)
        );

        const lines = text.split("\n").filter(Boolean);
        const matches = lines.filter(line => config.pattern.test(line));

        ctx.checkpoint.defer({ offset: nextOffset, ino: file.ino });

        ctx.logger.debug?.(
          "log file poll result",
          { path: config.path, readBytes: nextOffset - offset, lines: lines.length, matches: matches.length }
        );

        if (matches.length === 0) return;

        const shown = matches
          .slice(-config.maxLines)
          .map(line => clip(line, config.maxLineChars));

        const facts = { matches: matches.length };
        if (config.minimumDecision) {
          facts.minimum_decision = config.minimumDecision;
        }

        yield ctx.observation({
          id: `log:${config.name}:errors`,
          source: { type: "log", name: config.name },
          type: "log_errors",
          state: "error",
          title: `${matches.length} error line${matches.length === 1 ? "" : "s"} in ${config.name}`,
          message: [
            `New lines in ${config.path} matching ${config.pattern}:`,
            ...shown,
            matches.length > shown.length
              ? `(${matches.length - shown.length} earlier matching lines not shown)`
              : null
          ].filter(Boolean).join("\n"),
          facts,
          data: {
            path: config.path,
            lines: shown,
            totalMatches: matches.length,
            fromOffset: offset,
            toOffset: nextOffset
          }
        });
      }
    }
  }
});

export function normalizeConfig(config = {}) {
  if (typeof config.path !== "string" || !config.path) {
    throw new TypeError("log-file: config.path is required");
  }

  const path = resolve(config.path);

  return {
    path,
    name: config.name ?? basename(path),
    pattern: new RegExp(config.pattern ?? DEFAULT_PATTERN, config.flags ?? ""),
    startFromEnd: config.startFromEnd ?? true,
    maxLines: config.maxLines ?? 20,
    maxLineChars: config.maxLineChars ?? 300,
    maxReadBytes: config.maxReadBytes ?? 1024 * 1024,
    minimumDecision: config.minimumDecision ?? null
  };
}

/*
 * Reads up to `length` bytes from `offset` and keeps only the
 * complete lines; a partial last line is left for the next poll.
 */
async function readCompleteLines(path, offset, length) {
  if (length <= 0) return { text: "", nextOffset: offset };

  const handle = await open(path, "r");

  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const end = buffer.lastIndexOf(0x0a, bytesRead - 1);

    if (end === -1) return { text: "", nextOffset: offset };

    return {
      text: buffer.subarray(0, end + 1).toString("utf8"),
      nextOffset: offset + end + 1
    };
  }
  finally {
    await handle.close();
  }
}

function clip(value, max) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

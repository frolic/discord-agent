/**
 * Gzip a session JSONL into `<sessionDir>/archive/<channelId>-<UTC>.jsonl.gz`.
 * Returns the archive path on success, `null` if the source didn't exist
 * (no session yet — that's a valid no-op for `!clear`). Any other I/O
 * failure bubbles up: better to surface a loud failure than to leave the
 * channel half-cleared (in-memory entry evicted but the on-disk session
 * intact, which would resume on the next message and silently undo the
 * `!clear`).
 *
 * Two reasons for the `.jsonl.gz` extension (not plain `.jsonl`):
 *   1. Disk: sessions can be MB-sized; JSONL gzips ~8-15× (repeated keys
 *      and whitespace), so a long-lived agent home doesn't accumulate
 *      hundreds of MB of archived chat history.
 *   2. Hides from pi enumeration: pi's session walkers filter on
 *      `.endsWith(".jsonl")`, so archives won't show up as a pseudo
 *      "archive" agent in pi-TUI alongside live sessions.
 *
 * Replay: `gunzip -c <path> > /tmp/replay.jsonl && pi --session /tmp/replay.jsonl`
 * (pi doesn't read `.gz` directly).
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export async function archiveSession(
  sessionPath: string,
  channelId: string,
): Promise<string | null> {
  // Nest archives under sessions/ so backups / sync tools that already
  // cover sessions/ pick them up automatically, and the operator's
  // "where do conversations live" mental model stays single-rooted.
  const archiveDir = resolve(dirname(sessionPath), "archive");
  // YYYYMMDD-HHMMSS, UTC. Sortable, no colons (Windows-safe).
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "-",
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  const archivePath = resolve(archiveDir, `${channelId}-${stamp}.jsonl.gz`);
  // Stat-then-stream: race-y in theory (file could vanish between calls)
  // but on a single-threaded harness the source can't disappear after the
  // stat without somebody else editing the agent home. The pipeline below
  // would surface that as a stream error anyway.
  try {
    await stat(sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  await mkdir(archiveDir, { recursive: true });
  // Write to <archive>.partial, then rename to <archive>, then unlink the
  // source. Atomic publish at the final path — readers never see a
  // half-written `.gz`. If any step throws, bubble up; operator deals.
  const partialPath = `${archivePath}.partial`;
  await pipeline(createReadStream(sessionPath), createGzip(), createWriteStream(partialPath));
  await rename(partialPath, archivePath);
  await unlink(sessionPath);
  return archivePath;
}

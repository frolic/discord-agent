/**
 * Per-channel work-state store backed by a JSON file on disk. Survives
 * process restarts so the harness can resume mid-work after a crash or
 * intentional restart.
 *
 * Returned `ActiveTracker` is the only public surface; load/save and the
 * `update` helper stay closure-private. Callers can't reach into the map
 * directly, which keeps the file-format change radius bounded to this
 * file. Multiple trackers can coexist (different files) — useful for
 * tests; a fake tracker that satisfies the interface is also trivial to
 * write.
 *
 * The file is rewritten on every mutation. That's fine: the file is
 * tiny (one entry per active channel, a handful of small fields each),
 * and the simplicity of "always-consistent on disk" is worth more than
 * the write savings of a more elaborate scheme.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ChannelState } from "./common.ts";

type ActiveMap = Record<string, ChannelState>;

export interface ActiveTracker {
  /** User message arrived, no agent reply yet. Cleared on first successful delivery-tool call. */
  markPending(channelId: string): void;
  /** Mark pending AND cameFromRestart — the channel was put here by an intentional restart_self / !restart. */
  markRestart(channelId: string): void;
  /** Clear pending + cameFromRestart. Called when a delivery-tool succeeds. */
  markFulfilled(channelId: string): void;
  /** Toggle inTool based on tool execution events. */
  markInTool(channelId: string, inTool: boolean): void;
  /** Record the latest Discord message ID we received — used by recovery to build the catchup cursor. */
  markLastSeen(channelId: string, messageId: string): void;
  /** Clear pending/inTool/cameFromRestart but keep lastSeenMessageId. Called by recoverActive before each wake. */
  clearRecoveryFlags(channelId: string): void;
  /** Full nuke for `!clear` — drops every field including lastSeenMessageId. */
  clearChannel(channelId: string): void;
  /** Snapshot of every channel currently in the file. Recovery iterates this. */
  listChannels(): Array<{ channelId: string; state: ChannelState }>;
}

export function createActiveTracker(args: { activeStateFile: string }): ActiveTracker {
  const { activeStateFile } = args;

  function load(): ActiveMap {
    if (!existsSync(activeStateFile)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(activeStateFile, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      // Validate each channel entry — preserves the well-formed ones,
      // drops anything malformed (rather than crashing the whole startup
      // on a single bad entry).
      const map: ActiveMap = {};
      for (const [channelId, value] of Object.entries(parsed)) {
        if (isChannelState(value)) map[channelId] = value;
      }
      return map;
    } catch (error) {
      console.error(`[activeTracker] failed to read ${activeStateFile} — treating as empty:`, error);
      return {};
    }
  }

  function isChannelState(value: unknown): value is ChannelState {
    if (!value || typeof value !== "object") return false;
    if (!("pending" in value) || typeof value.pending !== "boolean") return false;
    if (!("inTool" in value) || typeof value.inTool !== "boolean") return false;
    if (!("cameFromRestart" in value) || typeof value.cameFromRestart !== "boolean") return false;
    if ("lastSeenMessageId" in value) {
      if (value.lastSeenMessageId !== undefined && typeof value.lastSeenMessageId !== "string") {
        return false;
      }
    }
    return true;
  }

  function save(map: ActiveMap): void {
    writeFileSync(activeStateFile, JSON.stringify(map, null, 2));
  }

  function isEmpty(state: ChannelState): boolean {
    return (
      !state.pending &&
      !state.inTool &&
      !state.cameFromRestart &&
      state.lastSeenMessageId === undefined
    );
  }

  function update(channelId: string, mutate: (state: ChannelState) => void): void {
    const map = load();
    const state = map[channelId] ?? {
      pending: false,
      inTool: false,
      cameFromRestart: false,
    };
    mutate(state);
    if (isEmpty(state)) {
      delete map[channelId];
    } else {
      map[channelId] = state;
    }
    save(map);
  }

  return {
    markPending(channelId) {
      update(channelId, (state) => {
        state.pending = true;
      });
    },
    markRestart(channelId) {
      update(channelId, (state) => {
        state.pending = true;
        state.cameFromRestart = true;
      });
    },
    markFulfilled(channelId) {
      update(channelId, (state) => {
        state.pending = false;
        state.cameFromRestart = false;
      });
    },
    markInTool(channelId, inTool) {
      update(channelId, (state) => {
        state.inTool = inTool;
      });
    },
    markLastSeen(channelId, messageId) {
      update(channelId, (state) => {
        state.lastSeenMessageId = messageId;
      });
    },
    clearRecoveryFlags(channelId) {
      update(channelId, (state) => {
        state.pending = false;
        state.inTool = false;
        state.cameFromRestart = false;
      });
    },
    clearChannel(channelId) {
      const map = load();
      delete map[channelId];
      save(map);
    },
    listChannels() {
      const map = load();
      return Object.entries(map).map(([channelId, state]) => ({ channelId, state }));
    },
  };
}

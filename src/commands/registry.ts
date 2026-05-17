/**
 * Lookup table mapping `!command` prefixes to their handlers. The router
 * iterates this in insertion order and dispatches to the first prefix
 * that matches `command.startsWith(prefix)`. Unknown commands fall
 * through to a `❓` react in the router.
 *
 * Prefix-match (not exact match) is intentional: it preserves the
 * historical behavior where `!stop now` and `!compact please` both
 * route. Prefixes must therefore be distinct and not overlap — a future
 * `!s` would shadow `!stop` if registered first.
 */
import type { CommandHandler } from "./common.ts";
import { handleClear } from "./handleClear.ts";
import { handleCompact } from "./handleCompact.ts";
import { handleRestart } from "./handleRestart.ts";
import { handleStop } from "./handleStop.ts";

export const commandRegistry: Record<string, CommandHandler> = {
  "!stop": handleStop,
  "!compact": handleCompact,
  "!clear": handleClear,
  "!restart": handleRestart,
};

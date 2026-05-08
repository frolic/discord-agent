/**
 * Names of tools that count as delivering something to the user channel
 * (alongside streamed assistant text). The active tracker treats these
 * the same way it treats a successful text-stream end: the channel's
 * `pending` flag clears.
 *
 * Streamed text is the primary delivery path. These tools cover the
 * non-text cases: reactions, file attachments, and thread spawns.
 */
const DELIVERY_TOOL_NAMES = ["react", "thread", "attach"] as const;

export const deliveryToolNameSet: ReadonlySet<string> = new Set(DELIVERY_TOOL_NAMES);

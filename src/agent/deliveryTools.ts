/**
 * Names of tools that count as delivering something to the user channel
 * (alongside streamed assistant text). The active tracker treats these
 * the same way it treats a successful text-stream end: the channel's
 * `pending` flag clears.
 *
 * In `stream` mode streamed text is the primary delivery path and these tools
 * cover the non-text cases: reactions, file attachments, and thread spawns. In
 * `tools` mode `send_message` is the primary path and joins the set; the name is
 * inert in stream mode (that tool isn't registered there).
 */
const DELIVERY_TOOL_NAMES = ["react", "thread", "attach", "send_message"] as const;

export const deliveryToolNameSet: ReadonlySet<string> = new Set(DELIVERY_TOOL_NAMES);

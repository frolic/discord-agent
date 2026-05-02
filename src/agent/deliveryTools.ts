/**
 * Single source of truth for the names of "delivery" tools — the ones the
 * envelope-tool rule treats as visible replies to the user. Used by:
 *
 *   - `installEnvelopeEnforcement`: a turn that called only delivery tools
 *     counts as having spoken to the user; a turn with no delivery tool
 *     and no other tool call is the silent-turn case.
 *   - `installActiveTracker`: only successful delivery-tool calls clear
 *     the channel's `pending` flag in active.json.
 *
 * Renaming a delivery tool means updating this constant only — duplicating
 * the list in either consumer would silently drift on the next rename.
 */
const DELIVERY_TOOL_NAMES = ["send", "react", "thread"] as const;

export const deliveryToolNameSet: ReadonlySet<string> = new Set(DELIVERY_TOOL_NAMES);

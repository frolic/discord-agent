/**
 * Per-tool-call usage display: pre-formatted strings ready to drop into
 * the log channel suffix. Built once when message_end fires for the LLM
 * call that issued the tool calls, attributed to the FIRST tool call in
 * the batch (siblings share — showing the same on each would be misleading).
 */
export interface CallUsageDisplay {
  tokensStr: string;
  costStr: string | null;
}

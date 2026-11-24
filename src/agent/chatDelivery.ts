/**
 * The hand-off between the live "typing" effect and the `send_message` tool.
 *
 * In `CHAT_MODE=tools` the model's reply is a tool call, so the text only exists
 * as tool-call *arguments* while it streams. The streamer watches
 * `toolcall_delta`, previews the growing `text` field into a live Discord
 * message, and — once the call ends — registers the finished delivery here. When
 * the tool's `execute` runs a moment later it *claims* that delivery instead of
 * posting a second copy.
 *
 * Two ways a reply can land, one owner each:
 *
 * - streamer posts it (claim returns the delivery) → the tool just reports back
 * - nothing was streamed (feature off, unreadable arguments, args arriving too
 *   fast to preview) → claim returns `undefined` and the tool posts it
 */
export interface StreamedDelivery {
  /** Messages the streamer already posted, in order. */
  messageIds: readonly string[];
  /** The authoritative text that was delivered. */
  text: string;
}

export interface ChatDelivery {
  /**
   * Note that this run put something in front of the user. Used to tell a
   * *rejected* reply (nothing was delivered) from trailing chatter after a
   * successful one ("Sent.", "Done.").
   */
  markDelivered(): void;
  deliveredThisRun(): boolean;
  /** Called at run start, so each turn answers the question for itself. */
  resetDelivered(): void;
  /**
   * Resolve what the streamer delivered for this tool call. Resolves
   * `undefined` when nothing was streamed, in which case the caller posts.
   */
  claimStreamed(toolCallId: string): Promise<StreamedDelivery | undefined>;
  /**
   * Reply target for a message about to be posted on completion — the message
   * that woke this run, only for the first message of that run. Consumes the
   * first-message flag so later messages in the same run do not repeat the
   * reply badge.
   */
  takeCompletionReplyTarget(): string | undefined;
}

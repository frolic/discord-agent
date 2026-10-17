/**
 * Build the options object for AgentSession.prompt(). Images attach when
 * present; `streamingBehavior: "steer"` engages when the session is already
 * busy (so a new user message gets injected as a steer rather than queued as a
 * separate prompt).
 *
 * `isBusy` is the session's busy flag, not `agent.state.isStreaming` — see
 * `isSessionBusy` in `createAgentPool.ts` for why the distinction matters.
 */
import type { ImageContent } from "@earendil-works/pi-ai";

interface PromptOptions {
  images?: ImageContent[];
  streamingBehavior?: "steer";
}

export function buildPromptOptions(args: {
  images: ImageContent[];
  isBusy: boolean;
}): PromptOptions {
  const options: PromptOptions = {};
  if (args.images.length > 0) {
    options.images = args.images;
  }
  if (args.isBusy) {
    options.streamingBehavior = "steer";
  }
  return options;
}

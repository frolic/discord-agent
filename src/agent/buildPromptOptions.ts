/**
 * Build the options object for AgentSession.prompt(). Images attach when
 * present; `streamingBehavior: "steer"` engages when a turn is already in
 * flight (so a new user message gets injected as a steer rather than
 * queued as a separate prompt).
 */
import type { ImageContent } from "@mariozechner/pi-ai";

interface PromptOptions {
  images?: ImageContent[];
  streamingBehavior?: "steer";
}

export function buildPromptOptions(args: {
  images: ImageContent[];
  isStreaming: boolean;
}): PromptOptions {
  const options: PromptOptions = {};
  if (args.images.length > 0) {
    options.images = args.images;
  }
  if (args.isStreaming) {
    options.streamingBehavior = "steer";
  }
  return options;
}

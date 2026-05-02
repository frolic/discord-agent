/**
 * Wrap a `ToolDefinition` so its execution emits a start-line in the log
 * channel and — if the tool result is an error — a follow-up failure
 * line that threads as a Discord reply to the start line.
 *
 * The wrap pattern keeps the start-log message ID in lexical scope, so
 * the failure handler can reference it without any out-of-band state
 * (no maps, no event-handler races). Compared to subscribing to
 * `tool_execution_start`/`tool_execution_end` events, this co-locates
 * the audit-trail behavior with the act of calling the tool, and works
 * uniformly across pi's built-in tools and the harness's custom tools as
 * long as both go through this wrapper.
 */
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";
import type { DebugLogger } from "../io/createDebugLogger.ts";

export function withToolLogging<schema extends TSchema, details, state>(
  tool: ToolDefinition<schema, details, state>,
  logger: DebugLogger,
): ToolDefinition {
  // The wrapped tool is structurally a ToolDefinition with the same shape
  // pi expects — execute/renderCall both call through to the original.
  // We widen the public return type from `ToolDefinition<schema, details, state>`
  // to bare `ToolDefinition` (which has `<TSchema, unknown, any>` defaults)
  // for one reason: callers collect wrappers of different concrete tools
  // into a single `ToolDefinition[]` for pi's `customTools` field, and
  // TypeScript rejects that mixing because `renderCall(args: Static<schema>, …)`
  // is contravariant in `schema`. Concretely typed wrappers can't unify
  // through the default-typed array element. Widening here is the cheapest
  // fix; the alternative is duplicating the cast at every collection site.
  const wrapped: ToolDefinition<schema, details, state> = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const startLog = logger.postToolStart({
        toolCallId,
        toolName: tool.name,
        args: params,
      });
      try {
        return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (error) {
        // Pi flags `isError` on the `tool_execution_end` event by catching
        // thrown errors from execute. Our wrapper sits inside that catch
        // boundary, so we see the throw first. Post the failure log here,
        // then re-throw so pi's normal error path runs.
        await logger.postToolFailure({
          replyTo: await startLog,
          toolName: tool.name,
          result: {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            details: {},
          },
        });
        throw error;
      }
    },
  };
  return wrapped as unknown as ToolDefinition;
}

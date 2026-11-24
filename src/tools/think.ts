/**
 * `think` — the reasoning outlet in `CHAT_MODE=tools`.
 *
 * The mode turns provider reasoning off (a reasoning model with thinking on will
 * spend its budget in an invisible block and then still write prose, which in
 * this mode goes to the log channel instead of the user). With reasoning off the
 * working-out needs somewhere to live that is *not* the user channel, and that is
 * this tool: the thought stays in the transcript as an ordinary tool call, so it
 * survives into later turns and compaction, and it never reaches Discord.
 *
 * It logs to the journal so an operator reading `journalctl -u …` can see what the
 * agent was thinking when a decision looks strange. The journal line is capped —
 * a long thought is not worth 200 lines of log.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** How much of a thought reaches the journal line. Full text stays in the transcript. */
const journalPreviewLimit = 400;

export function createThinkTool(args: { channelId: string }) {
  const { channelId } = args;
  return defineTool({
    name: "think",
    label: "think",
    description: `Work something out without saying it to the user. Nothing you pass here is posted to Discord — it stays in the conversation as your own notes and is visible to you in later turns.

Use it for planning, checking a claim before sending it, deciding which tool to call, or holding intermediate reasoning. Put anything the user should read in \`send_message\` instead.

This is the reasoning outlet for this mode: do the thinking here rather than in prose, because prose you write outside a tool call never reaches the user.`,
    parameters: Type.Object({
      thought: Type.String({
        description:
          "What you're working out. Your own notes — no need to phrase it for the user.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const preview =
        params.thought.length > journalPreviewLimit
          ? `${params.thought.slice(0, journalPreviewLimit)}…`
          : params.thought;
      console.log(`[think] ${channelId}: ${preview.replace(/\n/g, " ⏎ ")}`);
      return {
        content: [{ type: "text", text: "ok" }],
        details: { characters: params.thought.length },
        terminate: false,
      };
    },
  });
}

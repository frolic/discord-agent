# Persona

The bot's identity, system prompt, context, and skill library live at
the agent home root — pi auto-discovers everything from `agentDir`
(which the harness sets to your agent home).

```
<agent-home>/
  SYSTEM.md              # behavior, voice, rules (pi-native; auto-discovered)
  AGENTS.md              # background context, lore (pi-native; auto-discovered)
  skills/                # optional pi-format skills, auto-loaded
    <skill-name>/
      SKILL.md           # frontmatter + instructions
      <scripts and assets>
```

`SYSTEM.md` is your prompt verbatim. The harness layers a small,
non-negotiable "harness layer" section at the end describing how
delivery works (plain text streams to Discord; `attach` / `react` /
`thread` for files / emoji / thread-spawns), the inbound message-line
format (`user_id=… message_id=…` etc.), and the user-facing commands
(`!stop`, `!compact`, `!clear`, `!restart`). Defined in
[`../src/agent/prompts.ts`](../src/agent/prompts.ts) as `harnessRules`.
That's all the harness contributes — everything else is yours.

`AGENTS.md` (if present) is loaded by pi as project context — included
alongside the prompt as documentation rather than instruction. Use it
for *background you want the model to know*, not *rules for how the
model should behave*. Pi uses the same convention in its CLI; the file
behaves the same way here.

A starting template lives at [`../agent-template/`](../agent-template/)
— `bun run setup` copies it into your agent home, or copy by hand and
edit in place.

Sharing a persona is sharing the agent home directory — no code changes
on either side. Persona file edits require a harness restart to take
effect (skill *bodies* — content past the frontmatter — are read fresh
by the agent each time, so those are live).

The recommended workflow: `git init` inside `<agent-home>/` so the
whole thing is versioned, with `.env` / `auth.json` / `sessions/` /
`workspaces/` / `active.json` in `.gitignore`. That gives you
"versioned identity, unversioned secrets" — your bot's voice, skill
set, and pi config are portable and revertable; tokens never touch git.

## Good practice for building a persona

The split between system prompt and agents file mirrors the broader
distinction between *instruction* and *context*. Keeping them separate
makes both easier to iterate on.

### `SYSTEM.md` — behavior. Keep it tight.

Goes in:
- *Identity statement.* "You are X. You're a teammate in this Discord server."
- *Voice and tone.* Word choice, formality, length preferences,
  what to avoid ("don't use emoji unless the user does", "avoid
  bullet-pointing in casual chat").
- *Behavioral rules and hard constraints.* Things the bot must always
  or never do.
- *Tool-use guidance not already covered by the harness.* The harness
  appends Discord delivery rules automatically; you don't need to
  restate those.

Length: aim for **200–800 words**. Anything longer tends to dilute the
strongest signals. If your prompt grows past ~1000 words, the
overflow probably belongs in `AGENTS.md` (background) or skills
(specific capabilities), not in instructions sent on every call.

The system prompt is sent to the LLM **every** call, so every word costs
tokens. Be ruthless about cuts.

### `AGENTS.md` — context. Can be longer.

Goes in:
- *Identity card and lore.* Background story, history, relationships,
  ongoing projects, who the operator is, what's been built recently.
- *Project / domain context.* If the bot is embedded in a specific
  community, the rules and culture of that community.
- *Reference material the bot should know but not necessarily recite.*
  Past decisions, conventions, in-jokes, glossaries.

Length: 1–10 KB without strain. Pi treats this as documentation
included with the prompt — the model reads it when relevant rather
than reciting from it.

Why split: `AGENTS.md` can be edited without touching behavior, and
behavior can be tuned without rewriting identity. They also live in
different prompt slots, which the model interprets differently —
instructions get followed, context gets referenced.

### `skills/` — discrete capabilities.

Drop a `skills/` directory next to `SYSTEM.md`/`AGENTS.md` and the
harness loads it. Each skill is a subdirectory with a `SKILL.md`
(frontmatter + instructions) and any scripts/assets:

```
<agent-home>/
  skills/
    summarize-article/
      SKILL.md
    search-web/
      SKILL.md
      run.sh
```

Pi loads skills lazily: the frontmatter is read at startup so the model
knows *which* skills exist and when to use them, but the body (the
actual instructions) is read on demand via the `read` tool. Use skills
for capabilities that are self-contained workflows (e.g., "summarize a
long article", "search the web", "check Discord channel history") —
not for behavior rules (those go in `SYSTEM.md`) and not for static
context (that goes in `AGENTS.md`).

For more advanced setups (extra skill paths, npm-installable skill
packages, prompt templates, themes), see [pi's settings docs](https://github.com/badlogic/pi-mono/blob/v0.72.1/packages/coding-agent/docs/settings.md#resources).

# Goals

The properties this Discord agent should give a user. These are the
things a user notices and relies on — the feel any rebuild should
preserve.

## Core idea

The agent lives in Discord as a natural participant — someone who's in
the server, follows threads, and picks up conversations like a teammate
would. You interact with it the same way you'd grab a human: @mention
it, reply to its message, or talk in a thread it created.

## UX invariants

### 1. No commands to learn

You just talk to it. @mention, reply, or post in a thread — all work.
No syntax, no prefix. If someone asks how to use the agent, the answer
is "talk to it like a person."

The handful of slash commands (`/stop`, `/compact`, `/clear`, `/restart`)
are *operator* controls, not user vocabulary — they exist for the
person running the bot, not the people chatting with it.

### 2. Your conversation survives

The agent remembers what you were talking about, even if it restarts.
You never have to recap or re-explain. The conversation picks up where
it left off.

Coming back is coherent. Whether the agent quit cleanly to update
itself, got cut off mid-thought, or stopped mid-action — when it
returns, it slots back into the conversation appropriately. It doesn't
reboot into a confused "wait, where was I?" voice.

### 3. Heavy work gets its own space

When the agent needs to do something complex, it moves to a dedicated
thread. The main channel stays clean. The work has room to breathe.
You get progress updates and can steer it along the way. The thread is
the workspace, and it keeps a complete record of what happened.

### 4. You see progress in real time

Text appears as it's generated. Tool calls show up as they run. You
always know the agent is working and what it's doing. No waiting in
silence wondering if it's stuck.

If the agent is doing anything at all — thinking, acting, tidying its
own memory — you can tell. There's no state where it's busy but looks
idle.

### 5. You can redirect while it's working

If the agent heads in the wrong direction, you can correct it before
it finishes. Just send a message — the agent finishes its current
thought, then addresses your input. It's a conversation, not a
request-response cycle.

Editing your own message also counts as steering. If you fix a typo or
change your mind mid-turn, the agent sees the latest version with an
edit marker — not your first guess plus a follow-up correction.

### 6. Failures are handled, not hidden

If something goes wrong (garbage output, context overflow, crash), the
agent tells you. It explains what happened and offers a clean restart.
Work is never silently lost. You always know the state of your
conversation.

### 7. Files are part of the conversation

Send an image, the agent sees it. The agent writes a file, it's
attached to the response. No extra steps. Files flow naturally in both
directions.

### 8. The bot's character is yours

You describe its tone, what it knows, how it sounds, how it behaves.

### 9. You can tell what's running without looking inside

Is the bot up? What model is it using? When did it last restart?
These are visible from outside — at a glance, without logging into a
server or reading source. The bot publishes enough about itself that
anyone with eyes on the server can tell its state.

### 10. The bot's identity travels

A bot's voice and accumulated context aren't tied to the host it
happens to be running on. You can hand the bot to someone else, fork
it, give it a sibling, or move it between machines. Identity belongs
to the bot, not the infrastructure underneath.

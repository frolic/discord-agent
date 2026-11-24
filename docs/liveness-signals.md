# Liveness signals

Two files the harness writes so something *outside* this checkout can tell
whether the bot is actually working:

| File | Written | Contents |
|---|---|---|
| `~/.pollux/heartbeat` | immediately at startup, then every 30s | ISO timestamp of the last beat |
| `~/.pollux/ready` | once per boot, after Discord is connected | JSON: `at`, `bootedAt`, `pid`, `sha` (harness HEAD) |

Override the directory with `LIVENESS_DIR`; override the checkout whose SHA
gets stamped with `HARNESS_DIR`.

```ts
const liveness = startLivenessBeacon({ dir: config.livenessDir, harnessDir: config.harnessDir });
client.once("clientReady", () => liveness.markReady());
```

## Why it's shaped this way

The beacon is an input to policy, never a participant in it. It can say "I am
alive"; it cannot say "do not revert me". The consumer
([`pollux-deadmans-switch`](https://github.com/frolic/pollux/tree/main/infra/supervisor))
runs as root on a system timer, outside this repository, so a broken checkout
can never disable the thing that judges it.

The heartbeat starts before login on purpose: "a process exists and is
scheduling" is true from the first line of `src/index.ts`, and it's a stronger
signal than "we got as far as the Discord client". `ready` is stricter — it
means the gateway is connected and the session pool is bound — so a crashed or
hung boot never produces one.

A `ready` marker from a previous boot is deleted at startup. Without that, a
process that died during login would leave a fresh-looking marker behind and a
stale-ready check would never fire.

Every write is best-effort and logged on failure: liveness bookkeeping must
never be the reason the harness goes down.

# LAPLACE Rinnegan 輪廻眼

Detects **独轮车** — one viewer looping the same (or nearly the same) danmaku, usually through a tool such as
[LAPLACE Chatterbox](https://laplace.live/chatterbox) — in Bilibili Live rooms, and bans them through Bilibili's
official room silent-user API.
- **Offline**: replay a [LAPLACE Chat](https://chat.laplace.live) archive (`.lca`) and rank spammers with samples.
- **Live**: read events from [LAPLACE Event Fetcher](https://subspace.institute/docs/laplace-chat/event-fetcher)
  (bridge mode) or LAPLACE Event Bridge, judge every sender in real time, and ban with a reason. Without a
  [LAPLACE Login Sync](https://github.com/laplace-live/login-sync) token it runs as a dry run.
- Every decision goes to a JSONL **audit log**; real bans also go to a **ban store** (SQLite, Postgres or Redis) that
  other tools can build on — e.g. lift a ban once the user spends ¥30 in the room.

```bash
bun install
bun run src/cli.ts offline references/archive.lca
bun run src/cli.ts live --url ws://localhost:8080 --room 25034104          # dry run
LOGIN_SYNC_TOKEN='uuid@password' bun run src/cli.ts live --url ws://localhost:8080 --room 25034104
```

`bun run build` compiles a standalone `dist/rinnegan` binary.

## How it detects

Repetition alone never gets anyone banned. Fans in a hype moment send `?` or `老公天下第一` dozens of times by hand,
and the real archive this was calibrated on has hundreds of them. A ban needs **repetition plus proof of automation**:

| Evidence     | What it catches                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不可见字符   | Chatterbox 随机字符 / 路怒 / AI规避 inserting U+00AD, U+200B–U+200D, U+2060, U+FEFF, tag chars (U+E0020…) or blank fillers at shifting positions. Copies of someone else's jittered line (+1) don't count.                      |
| 发送节拍     | Chatterbox's 1 s default loop ticks every ~1.3 s (1010 ms queue gap + latency); Bilibili drops identical resends inside ~5 s, so accepted sends land on 5.2 / 6.5 / 7.8 s. Fitted per window and over the user's whole session. |
| 固定节拍     | `setInterval`-style loops (6 s, 8.2 s, 10 s…), tolerant of skipped beats. A beat on Bilibili's 5 s duplicate cooldown needs a longer, tighter run, because a human resending as soon as allowed is regular too.                 |
| 重复次数抖动 | Burst tools that repeat the phrase a random number of times per send (`爆了爆了爆了…`) to dodge dedup.                                                                                                                          |
| 机器速度     | The same line kept up at ≤ 2.5 s gaps for 20+ sends, which Bilibili's filter only allows when every send is altered.                                                                                                            |
| 模板轮播     | Several lines cycled on one timer (multi-line templates, chunked long text).                                                                                                                                                    |
| 插入字符     | A visible custom 随机字符 inserted at varying positions.                                                                                                                                                                        |
| 跟风触发     | Chatterbox 自动融入: every change of line is the first line to reach 3 users × 3 sends after its cooldown (below).                                                                                                              |

自动融入 copies what the room is already saying, at moments the room sets, so without 随机字符 it shows none of the
evidence above. Each send still follows from the room alone: a line fires once 3 users have sent it 3 times (a line idle
for 15 s starts over), then the bot ignores the room for its cooldown and counts from zero. Rinnegan replays that rule
for every sender under 14 fixed cooldowns (2–60 s) and the CPM-derived auto cooldown, each with and without
avoid-repeat, and follows resends Bilibili drops; sending the predicted line ≤ 2.5 s after the message that completed it
is a hit. A ban needs 12 hits covering ≥ 90% of the user's changes to a line others were sending inside the window
(people chasing trends by hand peak around 86%); 60% with 8 hits is partial evidence.

Messages are canonicalized first (NFKC, case, punctuation, invisible chars, repeated phrases with cut-off tails,
character runs) and grouped per user with a small edit-distance allowance, so all variants of one line count together.
Lines half the room is spamming lower the weight of pure repetition but never excuse automation. Scores run 0–100;
`spam` needs ≥ 90 **and** automation evidence, `suspect` starts at 60.

Patterns: `loop` 循环独轮车, `burst` 爆发刷屏, `template` 模板轮播, `blend` 跟风机器人 (Chatterbox 自动融入 and other trend
followers, jittered or trigger-timed), `flood` 高频重复 (repetition without automation evidence — reported, never banned).

### Accuracy

Calibrated on a real 89,970-message archive (5,725 users) and checked against simulated Chatterbox behaviour:
- Every Chatterbox technique is caught in simulation: all invisible-char presets, throttled identical loops, fixed and
  random intervals with 随机字符, templates, split long lines, visible custom chars, paraphrase cycling, keyword
  replacement, Copy Ninja mirrors and repeat-count burst tools. A random-interval loop **without** 随机字符 stays a
  suspect: clamped Gaussian jitter is too close to human pacing to ban on alone.
- 自动融入 injected into the real archive's busy hours is caught at every setting tried: stock, auto cooldown with and
  without avoid-repeat, 4 s with 29% random drop, 30 s, slow jittered latency and a 15-minute run. Random drop costs a
  hit per dropped trigger, so in rooms with several trends at once it can stay a suspect. People chasing the same
  trends by hand (0.5–6 s reactions) stay below `spam`; the most bot-like reach `suspect`.
- 0 of 1,000 simulated long human sessions and 0 of 300 mixed-room simulations reached `spam`; +1 copiers, check-in
  bots and sticker-panel sweeps stay below it.
- On the real archive, 42 users are judged `spam`, every one reviewed by hand (6 of them trend-following bots only the
  自动融入 replay catches); known traps (a fan who pasted a bot's line, heavy +1 users, the streamer, check-in bots) are
  not. Detection runs at ~80k messages/s.

Timing thresholds come from bootstrapping real human send gaps (200k resamples), set above the worst chance fit.

## Live mode

```bash
bun run src/cli.ts live --url ws://lef.example:8080 --token "$BRIDGE_TOKEN" --room 25034104
```

- `--url` points at LAPLACE Event Fetcher with `BRIDGE_MODE=1` (`ws://host:8080`) or Event Bridge (`ws://localhost:9696`).
  Rooms go to the fetcher as `?rooms=` and are filtered client-side as well; `--token` is its `BRIDGE_TOKEN`.
- The event source must be logged in (`LOGIN_SYNC_TOKEN` on the fetcher), otherwise Bilibili hides uids.
- `LOGIN_SYNC_TOKEN` (or `--login-sync-token`) is the `uuid@password` from the Login Sync extension; the Bilibili
  account must be the streamer or a room admin. Without it, or with `--dry-run`, bans are simulated and audited.
- On start Rinnegan reads each room's silent list (skipping users already banned, and proving it may moderate the
  room — a room it can't moderate falls back to detection only).
- Never banned: the streamer, room admins, `--exempt-uid`, optionally guards (`--exempt-guards`) and medal levels
  (`--exempt-medal`). Patterns outside `--patterns` are reported only.
- Safety brake: at most `--max-per-minute` bans per room per minute (default 5) and `--max-bans` per run (default 100).
- Reason (`msg`): `--reason '独轮车 ×{count}：{sample}'` (also `{minutes}`, `{pattern}`, `{score}`), capped at 60 chars.
- Bans are permanent by default (`--ban-hours -1`); `--expire-after <hours>` makes Rinnegan lift them itself.

### AI review (optional)

A second opinion before banning, mirroring LAPLACE Chatterbox's integrations:
- `--ai-provider jev` (default): the Typesafe **Jev** decision model, through OpenRouter (`--ai-protocol openrouter`,
  model `typesafe/jev-1.13`) or Typesafe directly (`--ai-protocol typesafe`, `jev-latest`).
- `--ai-provider llm`: any OpenAI-compatible chat model (OpenRouter by default), returning JSON.
- `--ai confirm`: every ban needs the reviewer's agreement (`--ai-threshold`, default 0.8).
- `--ai assist`: also reviews strong suspects (score ≥ 75 with partial automation evidence, e.g. a jittered timer,
  an LLM-polished loop or a partial 自动融入 replay) and bans when it agrees. It never bans on repetition alone.

Set the key with `RINNEGAN_AI_API_KEY`. Reviews are capped per hour; the reviewer sees the user's recent messages and
the detector's features, never their uid.

### Ban store and lift rules

Real bans are stored with time, reason, evidence and an optional expiry:

```bash
--store sqlite:data/rinnegan.sqlite      # default
--store postgres://user:pass@host/db     # Bun.sql
--store redis://host:6379                # Bun.redis
--unban-spend 30                          # lift a ban once the user spends ¥30 (gifts, SuperChats, guards) in the room
```

Lifting runs through `BanLifecycle` with pluggable `BanRule`s (`src/store/rules.ts`): `expiryRule()`,
`spendToUnbanRule(cny)`, or your own `onSpend` / `onTick` returning `keep`, `lift` or `extend`. A rule whose `onTick`
only acts on bans past `expiresAt` can set `tickScope: 'due'`; when every rule does, ticks read only those bans.

### Admin commands

```bash
bun run src/cli.ts bans --room 25034104                    # Bilibili's silent list + Rinnegan's records
bun run src/cli.ts unban --room 25034104 --uid 123 --uid 456
bun run src/cli.ts unban --session <audit session id>      # revert every real ban of one live run
```

## Offline mode

```bash
bun run src/cli.ts offline a.lca b.lca --room 25034104 --since '2026-10-20 20:00' --top 50
```

Accepts gzip and zstd `.lca` archives and raw JSON exports; pre-2026 lz-string archives must be re-exported from a
current LAPLACE Chat. Prints spammers then suspects with evidence and samples
(invisible chars shown as `⟨U+00AD⟩`), and writes JSON + Markdown reports to `reports/` (`--no-report` to skip). Times
are local; set `TZ=Asia/Shanghai` for Beijing time.

## Configuration

Precedence: defaults < `rinnegan.config.json` (or `--config`) < environment < flags. See
[`rinnegan.config.example.json`](rinnegan.config.example.json) and `bun run src/cli.ts --help`.

| Variable                                                                                                                                                    | Purpose                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `LOGIN_SYNC_TOKEN`, `LOGIN_SYNC_URL`, `LOGIN_SYNC_AUTH_KEY`                                                                                                 | Bilibili cookies via Login Sync |
| `RINNEGAN_EVENT_URL`, `RINNEGAN_EVENT_TOKEN`, `RINNEGAN_ROOMS`                                                                                              | Event source                    |
| `RINNEGAN_STORE_URL`, `RINNEGAN_LOG_DIR`, `RINNEGAN_REPORT_DIR`                                                                                             | Persistence                     |
| `RINNEGAN_AI_MODE`, `RINNEGAN_AI_PROVIDER`, `RINNEGAN_AI_PROTOCOL`, `RINNEGAN_AI_BASE`, `RINNEGAN_AI_API_KEY`, `RINNEGAN_AI_MODEL`, `RINNEGAN_AI_THRESHOLD` | AI review                       |

## Audit log

`logs/audit-YYYY-MM-DD.jsonl`, one JSON object per line with `ts`, `session`, `mode` and `event`: `session-start`,
`room-ready` / `room-unmanaged`, `detection`, `review` / `veto`, `ban` (with `dryRun`), `ban-failed`, `skip`, `brake`,
`unban`, `spend`, `connection`, `session-end`. Cookies, CSRF tokens and API keys are never written.

## Development

```bash
bun run lint && bun run typecheck && bun test
```

Tests that use real archives in `references/` skip when the files are absent. Postgres and Redis store tests run when
`RINNEGAN_TEST_DATABASE_URL` / `RINNEGAN_TEST_REDIS_URL` are set.

## License

AGPL-3.0

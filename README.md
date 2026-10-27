<img width="128" height="128" alt="logo-hexa-rinnegan-512" src="https://github.com/user-attachments/assets/28fdb8d6-373c-4119-a1a7-9c8578a805e4" />

# LAPLACE Rinnegan 輪廻眼

Detects **独轮车** (automated danmaku spammers looping the same or slightly mutated lines, typically via tools like
[LAPLACE Chatterbox](https://laplace.live/chatterbox)) in Bilibili Live rooms, and mutes them through Bilibili's
official silent-user API.
- **Offline**: replay a [LAPLACE Chat](https://chat.laplace.live) archive (`.lca`) and rank spammers with message
  samples.
- **Live**: stream events from [LAPLACE Event Fetcher](https://subspace.institute/docs/laplace-chat/event-fetcher)
  (bridge mode) or LAPLACE Event Bridge, score senders in real time, and ban spammers with a reason. Without a
  [LAPLACE Login Sync](https://github.com/laplace-live/login-sync) token or QR code login, it runs in dry-run mode.
- Every decision is written to a JSONL **audit log**; real bans are also saved to a **ban store** (SQLite, Postgres, or
  Redis) that downstream workflows can hook into—for example, automatically lifting a ban once the user spends ¥30 in
  the room.

```bash
bunx @laplace.live/rinnegan offline archive.lca
bunx @laplace.live/rinnegan live --url ws://localhost:8080 --room 25034104          # dry run
LOGIN_SYNC_TOKEN='uuid@password' bunx @laplace.live/rinnegan live --url ws://localhost:8080 --room 25034104
bunx @laplace.live/rinnegan login                                                   # or log in by QR code instead
```

Rinnegan requires [Bun](https://bun.sh) ≥ 1.3.7. `pnpx` and `npx` also work as long as `bun` is on your `PATH`, and
`bun add -g @laplace.live/rinnegan` installs the `rinnegan` binary used below. Paths for config, saved logins, logs,
and reports resolve relative to the current working directory.

## How it detects

Repetition alone never triggers a ban. During hype moments, real viewers manually spam `?` or `老公天下第一` dozens of
times—the archive used to calibrate Rinnegan has hundreds of viewers doing just that. A ban requires **repetition plus
proof of automation**:

| Evidence     | What it catches                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不可见字符   | Chatterbox 随机字符 / 路怒 / AI规避 modes inserting U+00AD, U+200B–U+200D, U+2060, U+FEFF, tag chars (U+E0020…), or blank fillers at shifting positions. Copying another viewer's obfuscated message (+1) is ignored.                 |
| 发送节拍     | Chatterbox's 1 s default loop ticks every ~1.3 s (1010 ms queue gap + latency); Bilibili silently drops identical resends within ~5 s, so accepted sends land at multiples of ~1.3 s (5.2 / 6.5 / 7.8 s). Fitted per window and session. |
| 固定节拍     | `setInterval`-style loops (6 s, 8.2 s, 10 s…), tolerant of skipped beats. Intervals near Bilibili's 5 s duplicate cooldown require a longer, tighter streak, since a human resending as soon as the cooldown clears looks regular too.  |
| 重复次数抖动 | Burst tools that vary how many times a phrase is repeated per send (`爆了爆了爆了…`) to bypass deduplication.                                                                                                                          |
| 机器速度     | Sustaining the same line at ≤ 2.5 s intervals for 20+ sends—something Bilibili's filter only lets through when every send is mutated.                                                                                                 |
| 模板轮播     | Cycling through multiple lines on a single timer (multi-line templates or long text split into chunks).                                                                                                                               |
| 插入字符     | Inserting a custom visible character (随机字符) at shifting positions.                                                                                                                                                                |
| 跟风触发     | Chatterbox 自动融入 (auto-blend): whenever the sender switches lines, the new line is the exact one that first reached 3 sends across 3 users after the bot's cooldown (see below).                                                    |

Because 自动融入 copies whatever the room is already chanting—at times dictated by the chat itself—running it without
随机字符 leaves none of the character or timer signatures above. Even so, its behavior is strictly deterministic: a
phrase triggers once 3 distinct users have sent it at least 3 times in total (resetting if the phrase goes idle for
15 s), after which the bot sleeps for its cooldown and starts counting from zero again. Rinnegan replays that state
machine for every sender across 14 fixed cooldowns (2–60 s) plus the CPM-based auto cooldown, both with and without
avoid-repeat, while tracking resends dropped by Bilibili; sending the predicted phrase within 2.5 s of the message that
completed the trigger counts as a hit. A ban requires at least 12 hits covering ≥ 90% of the user's switches to a
trending line (humans manually chasing trends top out around 86%), along with proof that the rule made non-trivial
choices: at least 3 hits where the cooldown skipped an earlier trend that the user also ignored, and at least 3 where
multiple trends qualified before the send. Without that check, in a room with only one chant at a time, every cooldown
setting predicts the same phrase and a human joining each chant by hand would match just as well as the bot. At ≥ 60%
coverage with 8 hits (including 3 cooldown skips), it counts as partial evidence.

Incoming messages are canonicalized first (NFKC, case, punctuation, invisible characters, repeated phrases with
truncated tails, and character runs) and clustered per user within a small edit-distance budget, so variations of the
same line are counted together. Phrases spammed by much of the room reduce the weight of raw repetition, but never
excuse automation signals. Scores range from 0 to 100: `spam` requires ≥ 90 **plus** automation evidence, while
`suspect` starts at 60.

Detected patterns: `loop` 循环独轮车, `burst` 爆发刷屏, `template` 模板轮播, `blend` 跟风机器人 (Chatterbox 自动融入 and
other trend-following bots, whether character-jittered or trigger-timed), and `flood` 高频重复 (high-frequency
repetition without automation evidence—reported, never banned).

### Accuracy

Calibrated against a real 89,970-message archive (5,725 users) and validated against simulated Chatterbox traffic:
- Every Chatterbox evasion mode is caught in simulation: all invisible-character presets, throttled identical loops,
  fixed and random intervals with 随机字符, multi-line templates, split long lines, custom visible characters,
  paraphrase cycling, keyword replacement, Copy Ninja mirrors, and repeat-count burst tools. A random-interval loop
  **without** 随机字符 is only flagged as `suspect`, since clamped Gaussian timing jitter alone is too close to human
  pacing to justify a ban.
- 自动融入 injected into busy hours of the real archive is caught across every tested configuration: default settings,
  auto cooldown (with and without avoid-repeat), 4 s cooldown with a 29% random drop rate, 30 s cooldown, a 10-character
  truncation limit, 2 s resends of truncated long lines, and high jittered latency. In quieter periods where trends
  rarely overlap, it remains at `suspect`, and random drops cost one hit per skipped trigger. Viewers manually joining
  the same trends (0.5–6 s reaction time)—even in rooms with only one chant at a time—stay below `spam`, with the most
  mechanical ones topping out at `suspect`.
- 0 of 1,000 simulated long human sessions and 0 of 300 mixed-room simulations reached `spam`; +1 copiers, check-in
  bots, and sticker-panel sweeps all stay below the threshold.
- On the real archive, all 41 users flagged as `spam` were manually verified (including 5 trend-following bots caught
  only by the 自动融入 replay), while known edge cases (a fan who copy-pasted a bot's line, heavy +1 users, the
  streamer, and check-in bots) were left untouched. Detection runs at ~80k messages/s.

Timing thresholds are derived by bootstrapping real human inter-message gaps (200k resamples) and set above the highest
false-positive match.

## Live mode

```bash
rinnegan live --url ws://lef.example:8080 --token "$BRIDGE_TOKEN" --room 25034104
```

- `--url` connects to LAPLACE Event Fetcher with `BRIDGE_MODE=1` (`ws://host:8080`) or Event Bridge
  (`ws://localhost:9696`). Room IDs are passed to the fetcher via `?rooms=` and also filtered client-side; `--token`
  sets the fetcher's `BRIDGE_TOKEN`.
- The event source itself must be logged in (`LOGIN_SYNC_TOKEN` on the fetcher); otherwise Bilibili masks sender UIDs.
- Issuing bans requires a Bilibili account with streamer or room-admin permissions, authenticated via Login Sync or QR
  code ([see below](#logging-in)). Without credentials—or when `--dry-run` is passed—bans are simulated and logged only.
- On startup, Rinnegan fetches each room's silent list both to skip already-banned users and to verify moderator
  permissions (rooms it cannot moderate automatically fall back to detection only).
- Exempt from bans: the streamer, room admins, `--exempt-uid`, and optionally guards (`--exempt-guards`) and medal
  holders (`--exempt-medal`). Patterns excluded from `--patterns` are reported without banning.
- Safety brake: caps bans at `--max-per-minute` per room per minute (default 5) and `--max-bans` per run (default 100).
- Ban reason (`msg`): `--reason '独轮车 ×{count}：{sample}'` (supports `{count}`, `{sample}`, `{minutes}`, `{pattern}`,
  `{score}`), truncated to 60 characters.
- Bans are permanent on Bilibili by default (`--ban-hours -1`); pass `--expire-after <hours>` to have Rinnegan lift them
  automatically after a set duration.

### Logging in

- **LAPLACE Login Sync**: set `LOGIN_SYNC_TOKEN` (or `--login-sync-token`) to the `uuid@password` shown by the browser
  extension. Cookies are refreshed every 30 minutes (`loginSync.refreshMinutes`) and whenever Bilibili rejects a
  session, staying in sync with your browser login.
- **QR code**: `rinnegan login` renders a QR code in the terminal—scan it with the Bilibili mobile app and confirm.
  Cookies are saved to `data/bilibili-login.json` (`--login-file`, `RINNEGAN_LOGIN_FILE`) with owner-only read
  permissions (`0600`). On Windows, the file inherits its parent directory's ACLs, so keep it in a private folder. To
  log out, stop any running `live` process and delete the file (the session itself remains valid on Bilibili until it
  expires). QR sessions are not auto-renewed: once Bilibili rejects the cookies, run `rinnegan login` again, and a
  running `live` process will reload the file on its next failed auth check.

Login Sync takes precedence if both are configured. `bans` and `unban` accept the same login options.

### AI review (optional)

Optional second opinion before issuing a ban, using the same provider setup as LAPLACE Chatterbox:
- `--ai-provider jev` (default): the Typesafe **Jev** decision model, via OpenRouter (`--ai-protocol openrouter`, model
  `typesafe/jev-1.13`) or directly via Typesafe (`--ai-protocol typesafe`, model `jev-latest`).
- `--ai-provider llm`: any OpenAI-compatible chat model (OpenRouter by default) returning structured JSON.
- `--ai confirm`: requires reviewer approval before executing a ban (`--ai-threshold`, default `0.8`).
- `--ai assist`: also sends high-scoring suspects (score ≥ 75 with partial automation evidence—such as a jittered timer,
  an LLM-paraphrased loop, or a partial 自动融入 match) for review and bans if approved. Pure repetition is never banned.

Set your API key via `RINNEGAN_AI_API_KEY`. Requests are rate-limited per hour, and prompts include only the user's
recent messages and extracted detector features—never their UID.

### Ban store and lift rules

Real bans are persisted with timestamp, reason, evidence, and an optional expiration time:

```bash
--store sqlite:data/rinnegan.sqlite      # default
--store postgres://user:pass@host/db     # Bun.sql
--store redis://host:6379                # Bun.redis
--unban-spend 30                         # lift a ban once the user spends ¥30 (gifts, SuperChats, guards) in the room
```

Automatic unbans are managed by `BanLifecycle` with pluggable `BanRule`s (`src/store/rules.ts`): built-in `expiryRule()`
and `spendToUnbanRule(cny)`, or custom `onSpend` / `onTick` hooks returning `'keep'`, `'lift'`, or `'extend'`. Rules
whose `onTick` only acts on expired bans can set `tickScope: 'due'`; when all active rules do so, periodic ticks query
only expired records.

### Admin commands

```bash
rinnegan bans --room 25034104                    # Bilibili's silent list + Rinnegan's records
rinnegan unban --room 25034104 --uid 123 --uid 456
rinnegan unban --session <audit session id>      # revert every real ban from a single live run
```

## Offline mode

```bash
rinnegan offline a.lca b.lca --room 25034104 --since '2026-10-20 20:00' --top 50
```

Accepts gzip- and zstd-compressed `.lca` archives as well as raw JSON exports (pre-2026 lz-string archives must be
re-exported from a current build of LAPLACE Chat). Prints detected spammers followed by suspects—with evidence and
message samples (rendering invisible characters like `⟨U+00AD⟩`)—and writes JSON and Markdown reports to `reports/`
(`--no-report` to skip). Timestamps use local time; set `TZ=Asia/Shanghai` for China Standard Time.

## Configuration

Precedence: defaults < `rinnegan.config.json` (or `--config`) < environment variables < CLI flags. See
[`rinnegan.config.example.json`](rinnegan.config.example.json) and `rinnegan --help`.

| Variable                                                                                                                                                    | Purpose                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `LOGIN_SYNC_TOKEN`, `LOGIN_SYNC_URL`, `LOGIN_SYNC_AUTH_KEY`                                                                                                 | Bilibili cookies via Login Sync |
| `RINNEGAN_LOGIN_FILE`                                                                                                                                       | Saved QR code login             |
| `RINNEGAN_EVENT_URL`, `RINNEGAN_EVENT_TOKEN`, `RINNEGAN_ROOMS`                                                                                              | Event source                    |
| `RINNEGAN_STORE_URL`, `RINNEGAN_LOG_DIR`, `RINNEGAN_REPORT_DIR`                                                                                             | Persistence                     |
| `RINNEGAN_AI_MODE`, `RINNEGAN_AI_PROVIDER`, `RINNEGAN_AI_PROTOCOL`, `RINNEGAN_AI_BASE`, `RINNEGAN_AI_API_KEY`, `RINNEGAN_AI_MODEL`, `RINNEGAN_AI_THRESHOLD` | AI review                       |

## Audit log

Written to `logs/audit-YYYY-MM-DD.jsonl`, one JSON object per line with `ts`, `session`, `mode`, and `event`:
`session-start`, `room-ready` / `room-unmanaged`, `detection`, `review` / `veto`, `ban` (with `dryRun`), `ban-failed`,
`skip`, `brake`, `unban`, `spend`, `connection`, and `session-end`. Cookies, CSRF tokens, and API keys are never logged.

## Development

```bash
bun install
bun run src/cli.ts offline references/archive.lca   # run from source
bun run lint && bun run typecheck && bun test
bun run build                                        # dist/cli.js, the bundle npm ships (built on pack/publish)
bun run compile                                      # standalone dist/rinnegan binary
bunx changeset                                       # describe a user-facing change (see Releasing)
```

Tests that rely on real archives in `references/` are skipped when those files are absent. Postgres and Redis store
tests run when `RINNEGAN_TEST_DATABASE_URL` / `RINNEGAN_TEST_REDIS_URL` are set.

## Releasing

Versions and the changelog are managed by [Changesets](https://changesets.dev). Never bump `version` in
`package.json`, push a release tag, or edit `CHANGELOG.md` by hand.

1. Every user-facing change ships with a changeset in the same commit. Run `bunx changeset`, or create a file under
   `.changeset/` directly:

   ```md
   ---
   "@laplace.live/rinnegan": minor
   ---

   feat: Log in to Bilibili by scanning a QR code
   ```

   Use `minor` for new features and substantial behavior changes, and `patch` for fixes and small adjustments. Start the
   summary with `feat:`, `fix:`, `perf:`, or `chore:`, followed by a single capitalized sentence written for users—the
   prefix is stripped and the rest lands verbatim in `CHANGELOG.md` and the GitHub Release. CI, docs, and refactors with
   no user-visible effect do not need a changeset; `bunx changeset status` lists pending changesets.
2. When changesets land on `master`, the Release workflow maintains an open `chore: version packages` PR that bumps the
   version and updates `CHANGELOG.md`.
3. Merging that PR publishes the new version to npm, tags `v<version>`, and creates the GitHub Release from the new
   changelog entry.

The Release workflow publishes via npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no token
required), so the package's settings on npmjs.com must list GitHub Actions as a trusted publisher for repository
`laplace-live/rinnegan` and workflow `release.yml`.

## License

AGPL-3.0

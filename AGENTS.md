# AGENTS.md

Guidance for coding agents working in this repository.

## Project

LAPLACE Rinnegan (輪廻眼) detects 独轮车 — danmaku looped by one user, usually through tools like
[LAPLACE Chatterbox](https://laplace.live/chatterbox) — in Bilibili Live rooms.
- **Live mode** reads `LaplaceEvent`s from LAPLACE Event Fetcher (bridge mode) or LAPLACE Event Bridge, and can ban
  through Bilibili's official silent-user API using cookies from LAPLACE Login Sync or a QR code login (`login`).
  Neither means dry-run.
- **Offline mode** replays a LAPLACE Chat archive (`.lca`) through the same detector and ranks spammers with samples.

Layout:

| Path            | What                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| `src/detect/`   | Canonicalization, timing metrics, crowd index and the streaming `Detector` |
| `src/sources/`  | `LaplaceEvent` → `ChatMessage`, `.lca` decoding, live bridge connection    |
| `src/bilibili/` | Bilibili web APIs (silent users, nav, room init), login-sync and QR login  |
| `src/store/`    | Persistent ban records (memory, SQLite, Postgres, Redis) and lift rules    |
| `src/ai/`       | Optional second opinion: Jev decision model or an OpenAI-compatible LLM    |
| `src/enforce/`  | Ban policy, exemptions, safety brake, dry-run                              |
| `src/audit/`    | JSONL audit log                                                            |
| `src/commands/` | `live`, `offline`, `bans`, `unban`, `login`                                |
| `src/cli.ts`    | Entry point                                                                |

Detection rules are calibrated against real archives in `references/` (gitignored, never commit them). Tests that need
them skip when the files are absent.

## Commands

```bash
bun install
bun run lint        # biome check
bun run typecheck   # bun check
bun test
bun run src/cli.ts offline references/<file>.lca
bun run build       # dist/cli.js, the bundle npm ships; prepack runs it
```

Always run `bun run lint`, `bun run typecheck` and `bun test` before finishing.

Published to npm as `@laplace.live/rinnegan` (`bunx @laplace.live/rinnegan`) by the Release workflow, never by hand.
The bundle inlines LAPLACE's own packages, so they are devDependencies; a third-party runtime package goes in
`dependencies` and in `build`'s `--external` list, so its license ships with it. Keep `engines.bun` at the oldest Bun
that passes `bun test`.

## Shipping a change

- **Every user-facing change ships with a changeset in the same commit** — add it yourself, unasked.

  ```bash
  bunx changeset add --minor @laplace.live/rinnegan -m "feat: Log in to Bilibili by scanning a QR code"
  ```

  `--minor` for new features and substantial behavior changes, `--patch` for fixes and small changes. Start the
  summary with `feat:`/`fix:`/`perf:`/`chore:`, then **one capitalized plain sentence under ~80 chars, written for
  users** — no rationale, no mechanism, no second line. The prefix is stripped and the rest ships verbatim in
  `CHANGELOG.md` and the GitHub Release ([README](README.md#releasing)).
- No changeset for CI, docs, tests, dev-only tooling, or refactors with no user-visible effect.
- **Never bump `version` in `package.json`, push a release tag, or hand-edit `CHANGELOG.md`** — merging the Release
  workflow's version PR does all three, then publishes to npm.

## Runtime

Use Bun, not Node.js: `bun test`, `bun:sqlite`, `Bun.sql` (Postgres), `Bun.redis` / `RedisClient`, built-in
`WebSocket`, `Bun.file`. Bun loads `.env` automatically, so don't use dotenv. Imports use the `@/` alias for `src/`.

## Code style

Biome enforces formatting: 2 spaces, single quotes, no semicolons, trailing commas (es5), 120 columns.

### Comments

Comments must be **sparse and terse** — verbosity is the problem; a long comment is worse than no comment. One
exception: **JSDoc/TSDoc doc-comments** (`/** … */`) attached to a declaration surface in editor hover and autocomplete
— keep them, but keep them tight.
- **Keep doc-comments on declarations**, one line where you can; reach for `@param`/`@returns` only to add what the
  signature can't say (units, ranges, edge cases).
- **Cut name-restaters elsewhere.** No inline note that merely restates a name, type or obvious operation.
- **Keep only genuinely non-obvious information, in 1–2 lines** — an edge case, a non-obvious _why_, a workaround, an
  invariant, units, or a gotcha.
- **Never remove or alter** tooling directives (`@ts-expect-error`, `biome-ignore`, …) or `TODO`/`FIXME` notes.

### Conventions

- User-facing console and log text is Chinese where it describes Bilibili concepts; identifiers and code comments are
  English.
- Never log cookies, CSRF tokens, login-sync tokens or API keys.
- Network clients take an injectable `fetch` so tests never hit the network.

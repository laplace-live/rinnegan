# AGENTS.md

Guidance for coding agents working in this repository.

## Project

LAPLACE Rinnegan (輪廻眼) detects 独轮车 — danmaku looped by one user, usually through tools like
[LAPLACE Chatterbox](https://laplace.live/chatterbox) — in Bilibili Live rooms.
- **Live mode** reads `LaplaceEvent`s from LAPLACE Event Fetcher (bridge mode) or LAPLACE Event Bridge, and can ban
  through Bilibili's official silent-user API using cookies from LAPLACE Login Sync or a QR code login (`login`).
  Neither means dry-run.
- **Offline mode** replays a LAPLACE Chat archive (`.lca`) through the same detector and ranks spammers with samples.

A Bun workspace of two npm packages: the CLI, `@laplace.live/rinnegan` in `apps/rinnegan`, and the detector,
`@laplace.live/rinnegan-sdk` in `packages/sdk`, which the CLI bundles and other apps such as LAPLACE Chat can reuse.

Layout:

| Path                          | What                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `packages/sdk/src/`           | Canonicalization, timing metrics, crowd index and the streaming `Detector`      |
| `packages/sdk/src/events.ts`  | `LaplaceEvent` → `ChatMessage`, and an archive's sheets → time-ordered messages |
| `apps/rinnegan/src/sources/`  | `.lca` decoding, live bridge connection, spend events                           |
| `apps/rinnegan/src/bilibili/` | Bilibili web APIs (silent users, nav, room init), login-sync and QR login       |
| `apps/rinnegan/src/store/`    | Persistent ban records (memory, SQLite, Postgres, Redis) and lift rules         |
| `apps/rinnegan/src/ai/`       | Optional second opinion: Jev decision model or an OpenAI-compatible LLM         |
| `apps/rinnegan/src/enforce/`  | Ban policy, exemptions, safety brake, dry-run                                   |
| `apps/rinnegan/src/report/`   | Offline reports: console, Markdown, JSON and the self-contained HTML page       |
| `apps/rinnegan/src/audit/`    | JSONL audit log                                                                 |
| `apps/rinnegan/src/commands/` | `live`, `offline`, `bans`, `unban`, `login`                                     |
| `apps/rinnegan/src/cli.ts`    | Entry point                                                                     |

Detection rules are calibrated against real archives in `references/` (gitignored, never commit them). Tests that need
them skip when the files are absent.

## Commands

```bash
bun install
bun run lint        # biome check
bun run typecheck   # bun check in each package; the SDK also against tsconfig.build.json
bun test            # every package
bun run offline references/<file>.lca
bun run build       # apps/rinnegan/dist/cli.js and packages/sdk/dist, what npm ships; prepack runs each
```

Always run `bun run lint`, `bun run typecheck` and `bun test` before finishing.

Both packages are published to npm by the Release workflow, never by hand.
- **CLI** (`bunx @laplace.live/rinnegan`): the bundle inlines the SDK and LAPLACE's own packages, so they are
  devDependencies; a third-party runtime package goes in `dependencies` and in `build`'s `--external` list, so its
  license ships with it. Keep `engines.bun` at the oldest Bun that passes `bun test`.
- **SDK**: `tsc` output that browsers load too, so no Bun or Node APIs (`tsconfig.build.json` loads no `types`, so
  using one fails the typecheck) and no runtime dependencies; `@laplace.live/event-types` is an optional peer, for
  types only. Its `index.ts` is the public API. It is MIT-licensed, while the CLI and the rest of the repo are
  AGPL-3.0.

## Shipping a change

- **Every user-facing change ships with a changeset in the same commit** — add it yourself, unasked.

  ```bash
  bunx changeset add --minor @laplace.live/rinnegan -m "feat: Log in to Bilibili by scanning a QR code"
  ```

  `--minor` for new features and substantial behavior changes, `--patch` for fixes and small changes. Start the
  summary with `feat:`/`fix:`/`perf:`/`chore:`, then **one capitalized plain sentence under ~80 chars, written for
  users** — no rationale, no mechanism, no second line. The prefix is stripped and the rest ships verbatim in
  `CHANGELOG.md` and the GitHub Release ([README](README.md#releasing)).
- The CLI bundles the SDK, so an SDK change that CLI users will notice names both packages:
  `bunx changeset add --minor @laplace.live/rinnegan-sdk,@laplace.live/rinnegan -m "…"`.
- No changeset for CI, docs, tests, dev-only tooling, or refactors with no user-visible effect.
- **Never bump `version` in `package.json`, push a release tag, or hand-edit `CHANGELOG.md`** — merging the Release
  workflow's version PR does all three, then publishes to npm.

## Runtime

The CLI uses Bun, not Node.js: `bun test`, `bun:sqlite`, `Bun.sql` (Postgres), `Bun.redis` / `RedisClient`, built-in
`WebSocket`, `Bun.file`. Bun loads `.env` automatically, so don't use dotenv. Its imports use the `@/` alias for its
`src/`, and `@laplace.live/rinnegan-sdk`, which its tsconfig `paths` points at the SDK's source, so nothing needs
building first.

The SDK imports its own modules by relative path with a `.ts` extension, which `tsc` rewrites to `.js`; an `@/` alias
would survive into `dist/`. Its spam simulators and event factories in `src/testing/` serve the CLI's tests too, and
stay out of the build.

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
- Times are read and shown in `config.timeZone` (China time by default), whatever the machine's zone: parse with
  `parseTime` from `@/util/time` and format with `@/util/console`, never with local-time `Date` methods.

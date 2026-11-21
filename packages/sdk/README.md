# @laplace.live/rinnegan-sdk

The 独轮车 detector behind [LAPLACE Rinnegan](https://github.com/laplace-live/rinnegan), as a library. Feed it Bilibili
Live danmaku in time order and it scores every sender, with the evidence behind each verdict. It has no runtime
dependencies and runs wherever modern JavaScript does: browsers, Bun, Node.js and Workers.

```bash
bun add @laplace.live/rinnegan-sdk
bun add @laplace.live/event-types   # optional peer: types the LaplaceEvents used below
```

## Judge danmaku as they arrive

```ts
import type { LaplaceEvent } from '@laplace.live/event-types'
import { Detector, PATTERN_LABELS, toChatMessage, VERDICT_LABELS } from '@laplace.live/rinnegan-sdk'

const detector = new Detector()

function onEvent(event: LaplaceEvent) {
  if (event.type !== 'message') return
  const message = toChatMessage(event)
  // A string says why the danmaku can't be judged: 'anonymous', 'auto-danmaku', 'mirror', 'empty' or 'mock'
  if (typeof message === 'string') return
  const { assessment, changed } = detector.ingest(message)
  if (changed) {
    const { uname, verdict, score, pattern } = assessment
    console.log(`${uname}: ${VERDICT_LABELS[verdict]} ${score} · ${PATTERN_LABELS[pattern]}`)
  }
}
```

`ingest` returns the sender's assessment after that message. `changed` is set when the verdict rose, or a flagged
user's score climbed 5 points since the last change, so a UI can update without flicker. One `Detector` handles any
number of rooms. It keeps each user's messages for a sliding window (`windowMs`, 10 minutes by default), but every
flagged user's peak and episodes, and each viewer's 手动融入 tally, stay for the whole session: start a new `Detector`
per stream to release them.

Without `@laplace.live/event-types`, keep `skipLibCheck` on, since the types of `toChatMessage` and `extractMessages`
refer to it. Danmaku from elsewhere can be passed to `ingest` directly as a `ChatMessage`.

## Rank a whole archive

```ts
import { Detector, extractMessages } from '@laplace.live/rinnegan-sdk'

// `sheets`: the EventSheet[] inside a LAPLACE Chat archive, decompressed and parsed
const { messages, skipped } = extractMessages(sheets, { since: Date.parse('2026-11-20T00:00:00+08:00') })
const detector = new Detector()
for (const message of messages) detector.ingest(message)

const flagged = detector.summaries() // users who reached `suspect`, worst first, with their peak and flagged stretches
const copiers = detector.manualBlends() // 手动融入: viewers who copy the room by hand, never flagged
```

## Reading an assessment

- `verdict`: `spam` (a 独轮车), `suspect` or `none`. Repetition alone never reaches `spam`: that also needs automation
  evidence (`proof` ≥ `minAutomation`).
- `score`: 0–100, from the repeats in the window weighted by how sure the evidence is.
- `pattern`: `loop`, `burst`, `template`, `blend` (a trend-following bot such as Chatterbox's 自动融入) or `flood`.
- `evidence`: what proves automation, each with a `kind`, a 0–1 `weight` and a `detail` in Chinese.
- `clusters`: the user's top repeated lines, with sample messages.

`VERDICT_LABELS`, `PATTERN_LABELS`, `EVIDENCE_LABELS`, `SKIP_LABELS`, `GUARD_LABELS` and `USER_TYPE_LABELS` hold the
Chinese names Rinnegan shows. `new Detector(options)` takes any of `DEFAULT_DETECTOR_OPTIONS` to override, such as the
score thresholds.

The text helpers the detector uses are exported too: `canonicalize` folds a line's dedup-bypass variants into one key,
`findEvasionChars` / `stripEvasionChars` find and remove the invisible characters tools insert, `escapeInvisible`
shows them as `⟨U+00AD⟩`, and `invisibleRuns` splits a line around them for your own rendering.

How each kind of 独轮车 is caught, and how accurate that is on real rooms:
[How it detects](https://github.com/laplace-live/rinnegan#how-it-detects).

## License

MIT

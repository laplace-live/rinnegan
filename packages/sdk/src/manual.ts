import { CrowdIndex } from './crowd.ts'
import { graphemeLength } from './normalize.ts'
import { median } from './timing.ts'

/** A send copies a line someone else sent this recently: it was still on screen */
const COPY_WINDOW_MS = 60_000
/** A copied line this many others had just sent is a chant; fewer, a +1 of someone's line */
const CHANT_USERS = 3
/** Lines this short are reactions like 「？」 or 「牛逼」, typed alike without copying: counted only in a chant */
const REACTION_LENGTH = 2
/** Plain Latin, CJK, Hangul and full-width text has one grapheme per UTF-16 unit, so needs no segmenter */
const ONE_UNIT_GRAPHEMES = /^[\u0020-\u02ff\u3000-\u9fff\uac00-\ud7a3\uff00-\uffef]*$/
/** Copies that earn the mark, and their least share of the user's text sends */
const MIN_COPIES = 20
const MIN_COPY_SHARE = 0.5
/** Least share of line changes to a line nobody else had just sent; accounts left to 自动融入 stayed under 12% */
const MIN_OWN_SHARE = 0.2
/** Automation proof on any of the user's assessments that rules the mark out */
const TOOL_PROOF = 0.5
const SAMPLES_KEPT = 3
const LAGS_KEPT = 64

/** One copied send: a chant, or a +1, which names whose line it copied. */
export type CopySample = CopiedLine | (CopiedLine & PlusOneSource)

interface CopiedLine {
  at: number
  text: string
  /** Others who sent the line in the minute before */
  senders: number
}

interface PlusOneSource {
  /** Who sent the line last before the user */
  from: string
  /** How long after them, ms */
  lagMs: number
}

/** A viewer's copying over the session, when it earns the 手动融入 mark. */
export interface ManualBlend {
  roomId: number
  uid: number
  uname: string
  /** Text sends; stickers, @-replies and lone short reactions aside */
  sends: number
  /** Sends of a line someone else sent in the minute before */
  copies: number
  /** Copies of a line {@link CHANT_USERS}+ others were sending */
  chants: number
  /** People whose lines the user +1'd */
  sources: number
  /** Line changes, and those to a line nobody else had just sent */
  switches: number
  ownSwitches: number
  /** Median delay of a +1 after the send it copied, ms; null without +1s */
  plusOneLagMs: number | null
  /** The longest copies, oldest first: a long line sent verbatim shows the copying best */
  samples: CopySample[]
}

interface Habit extends Omit<ManualBlend, 'sources' | 'plusOneLagMs'> {
  sources: Set<number>
  /** Latest +1 delays, ms */
  lags: number[]
  lastKey: string | null
  /** An assessment found automation proof */
  tool: boolean
}

/**
 * 手动融入: viewers who mostly send what others just sent (chants and +1s) by hand, with lines of their own in between.
 * Tallied over the whole session; the mark describes a habit and never bans or exempts anyone.
 */
export class ManualBlendIndex {
  readonly #recent = new CrowdIndex(COPY_WINDOW_MS)
  /** `${roomId}:${uid}` → habit, kept for the session */
  readonly #habits = new Map<string, Habit>()

  /** Count one text send; feed every room's sends in time order. */
  observe(roomId: number, uid: number, uname: string, key: string, text: string, at: number): void {
    this.#recent.add(roomId, key, uid, at)
    const senders = this.#recent.others(roomId, key, uid)
    if (senders < CHANT_USERS && isReaction(key)) return
    const habit = this.#habit(roomId, uid, uname)
    habit.sends++
    if (key !== habit.lastKey) {
      habit.switches++
      if (senders === 0) habit.ownSwitches++
      habit.lastKey = key
    }
    if (senders === 0) return
    habit.copies++
    if (senders >= CHANT_USERS) {
      habit.chants++
      keepLongest(habit.samples, { at, text, senders })
      return
    }
    // Only a +1 looks up its source: two senders at most, where a chant's thousands would make each send O(n).
    const last = this.#recent.latest(roomId, key, uid)
    if (!last) return
    habit.sources.add(last.uid)
    habit.lags.push(at - last.at)
    if (habit.lags.length > LAGS_KEPT) habit.lags.shift()
    const from = this.#habits.get(`${roomId}:${last.uid}`)?.uname || `uid ${last.uid}`
    keepLongest(habit.samples, { at, text, senders, from, lagMs: at - last.at })
  }

  /** Note an assessment's automation proof: signs of a tool rule the mark out for the session. */
  judged(roomId: number, uid: number, uname: string, proof: number): void {
    if (proof >= TOOL_PROOF) this.#habit(roomId, uid, uname).tool = true
  }

  /** The user's copying when it earns the mark, else null. */
  get(roomId: number, uid: number): ManualBlend | null {
    const habit = this.#habits.get(`${roomId}:${uid}`)
    return habit && earns(habit) ? summarize(habit) : null
  }

  /** Everyone earning the mark, most copies first. */
  all(): ManualBlend[] {
    const out: ManualBlend[] = []
    for (const habit of this.#habits.values()) if (earns(habit)) out.push(summarize(habit))
    return out.sort((a, b) => b.copies - a.copies || b.sends - a.sends)
  }

  #habit(roomId: number, uid: number, uname: string): Habit {
    const id = `${roomId}:${uid}`
    let habit = this.#habits.get(id)
    if (!habit) {
      habit = {
        roomId,
        uid,
        uname,
        sends: 0,
        copies: 0,
        chants: 0,
        sources: new Set(),
        switches: 0,
        ownSwitches: 0,
        lags: [],
        samples: [],
        lastKey: null,
        tool: false,
      }
      this.#habits.set(id, habit)
    }
    habit.uname = uname || habit.uname
    return habit
  }
}

function isReaction(key: string): boolean {
  if (key.length <= REACTION_LENGTH) return true
  return !ONE_UNIT_GRAPHEMES.test(key) && graphemeLength(key) <= REACTION_LENGTH
}

/** Keep the {@link SAMPLES_KEPT} longest copies; a tie keeps the earlier one. */
function keepLongest(samples: CopySample[], sample: CopySample): void {
  if (samples.length < SAMPLES_KEPT) {
    samples.push(sample)
    return
  }
  let shortest = 0
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i] as CopySample).text.length < (samples[shortest] as CopySample).text.length) shortest = i
  }
  if (sample.text.length <= (samples[shortest] as CopySample).text.length) return
  samples.splice(shortest, 1)
  samples.push(sample)
}

function earns(habit: Habit): boolean {
  return (
    !habit.tool &&
    habit.copies >= MIN_COPIES &&
    habit.copies >= MIN_COPY_SHARE * habit.sends &&
    habit.ownSwitches >= MIN_OWN_SHARE * habit.switches
  )
}

function summarize(habit: Habit): ManualBlend {
  return {
    roomId: habit.roomId,
    uid: habit.uid,
    uname: habit.uname,
    sends: habit.sends,
    copies: habit.copies,
    chants: habit.chants,
    sources: habit.sources.size,
    switches: habit.switches,
    ownSwitches: habit.ownSwitches,
    plusOneLagMs: habit.lags.length > 0 ? median(habit.lags) : null,
    samples: habit.samples.map(sample => ({ ...sample })),
  }
}

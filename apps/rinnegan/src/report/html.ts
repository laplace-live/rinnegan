import type { ManualBlend, Pattern, SkipReason, TalliedSend } from '@laplace.live/rinnegan-sdk'
import {
  clip,
  EVIDENCE_LABELS,
  GUARD_LABELS,
  invisibleRuns,
  PATTERN_LABELS,
  SKIP_LABELS,
  USER_TYPE_LABELS,
  VERDICT_LABELS,
} from '@laplace.live/rinnegan-sdk'

import type { Activity, Badges, CountedKind, DanmakuMix, GapHistogram, Lane, LeftOutKind } from '@/report/activity'
import type { OfflineReport, ReportUser } from '@/report/report'

import { leftOutKind, sendKind, TIMELINE_CONTEXT_MS } from '@/report/activity'
import SCRIPT from '@/report/page/script.js' with { type: 'text' }
import STYLE from '@/report/page/style.css' with { type: 'text' }
import { copyNote, formatGap, formatScore, nameOf, repeatsText, userKey } from '@/report/report'
import {
  clock,
  count,
  dateTime,
  hourMinute,
  localDate,
  monthDay,
  sameYear,
  utcOffset,
  utcOffsets,
} from '@/util/console'

export interface HtmlOptions {
  /** Archive file names for the header; never full paths, which can name the local user */
  archives: string[]
}

const REPO_URL = 'https://github.com/laplace-live/rinnegan'

/**
 * 打码: a switch that blurs every `.pii` for screenshots, through CSS alone. WebKit ignores CSS `blur()` on SVG, so the
 * chart's names take the SVG filter.
 */
const MASK_SWITCH = `<label class="mask" title="模糊观众的用户名和 UID，方便截图分享"><input type="checkbox" id="mask" role="switch"><span class="knob" aria-hidden="true"></span>打码</label>
<svg class="defs" aria-hidden="true"><filter id="pii-blur" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="4"/></filter></svg>`

/** Times within one line of text, which dates its first time and any later one on a new day. */
interface LineClock {
  minute(ms: number): string
  range(from: number, to: number): string
}

interface Clock {
  line(): LineClock
  second(ms: number): string
}

interface Context {
  report: OfflineReport
  activity: Activity
  options: HtmlOptions
  at: Clock
  /** Flagged users and 手动融入 viewers by {@link userKey}, for the links between their cards and entries */
  flaggedByKey: Map<string, ReportUser>
  /** With each viewer's place in the 手动融入 list, from 1 */
  manualByKey: Map<string, { blend: ManualBlend; n: number }>
}

/** What the 手动融入 tally counts a text danmaku as, by the CSS class that colors it. */
const COUNTED: Record<CountedKind, string> = { chant: '跟队形', 'plus-one': '+1', own: '自己说的' }

/** Danmaku the tally leaves out, which share one gray part of the bar, `other`. */
const LEFT_OUT: Record<LeftOutKind, string> = { short: '短句', emote: '表情', reply: '回复' }

/** `短句和表情`, `短句、表情和回复` */
const ZH_LIST = new Intl.ListFormat('zh')

/** A part of a user's danmaku bar; also a danmaku's dot in lists. */
type Part = CountedKind | 'other'

/** One part of the bar: its name and count, and the lines its tooltip adds about what it holds. */
interface BarPart {
  part: Part
  name: string
  n: number
  notes: string[]
}

const TILE_LABELS = { ...VERDICT_LABELS, manual: '手动融入' }

function chip(label: string): string {
  return `<span class="cp">${label}</span>`
}

/** Markup that 打码 blurs: a viewer's name or UID. */
function pii(html: string): string {
  return `<span class="pii">${html}</span>`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** {@link danmaku}, with each of the viewer `names` it quotes hidden by 打码. */
function named(text: string, names: readonly string[] = []): string {
  // Longest first, so a name that holds another is wrapped whole
  const found = names.filter(Boolean).sort((a, b) => b.length - a.length)
  if (found.length === 0) return danmaku(text)
  return text
    .split(new RegExp(`(${found.map(escapeRegExp).join('|')})`))
    .map((part, i) => (i % 2 === 1 ? pii(danmaku(part)) : danmaku(part)))
    .join('')
}

/** Escaped danmaku with tool-inserted invisible chars as `U+00AD` chips; a run of one char collapses to `×n`. */
function danmaku(text: string): string {
  return invisibleRuns(text)
    .map(run =>
      typeof run === 'string' ? Bun.escapeHTML(run) : chip(run.times > 1 ? `${run.label} ×${run.times}` : run.label)
    )
    .join('')
}

/** Local times, dated only when the archive spans more than one day. */
function clockFor(from: number, to: number): Clock {
  const dated = localDate(from) !== localDate(to)
  const day = sameYear(from, to) ? monthDay : localDate
  return {
    second: ms => (dated ? `${day(ms)} ${clock(ms)}` : clock(ms)),
    line: () => {
      let shown = ''
      const minute = (ms: number) => {
        const date = localDate(ms)
        const prefix = dated && date !== shown ? `${day(ms)} ` : ''
        shown = date
        return `${prefix}${hourMinute(ms)}`
      }
      return {
        minute,
        range: (a, b) => {
          const start = minute(a)
          if (localDate(a) !== localDate(b)) return `${start} – ${minute(b)}`
          const end = hourMinute(b)
          return end === hourMinute(a) ? start : `${start}–${end}`
        },
      }
    },
  }
}

function nowrap(html: string): string {
  return `<span class="nowrap">${html}</span>`
}

/** Anchors go by rank, not UID, which 打码 would leave in the address bar. */
function cardId(user: ReportUser): string {
  return `u-${user.rank}`
}

/** Anchor of the `n`th 手动融入 entry. */
function manualId(n: number): string {
  return `m-${n}`
}

/** What the room-wide traffic line counts. */
function roomScope(report: OfflineReport): string {
  return report.archive.rooms.length > 1 ? '所有房间' : '全房间'
}

function link(href: string, html: string, cls = ''): string {
  return `<a${cls ? ` class="${cls}"` : ''} href="${Bun.escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`
}

/** Danmaku per bucket, as a unit. */
function perBucket(bucketMs: number): string {
  const minutes = bucketMs / 60_000
  if (minutes === 1) return '条/分钟'
  return minutes < 60 ? `条/${minutes} 分钟` : `条/${minutes / 60} 小时`
}

/**
 * The offline report as one self-contained HTML page: styles, chart script and data are inline and nothing loads
 * from the network, so it opens from disk in any current browser.
 */
export function renderHtml(report: OfflineReport, activity: Activity, options: HtmlOptions): string {
  const ctx: Context = {
    report,
    activity,
    options,
    at: clockFor(report.archive.from, report.archive.to),
    flaggedByKey: new Map(report.users.map(user => [userKey(user), user])),
    manualByKey: new Map(report.manualBlends.map((blend, i) => [userKey(blend), { blend, n: i + 1 }])),
  }
  const title = [roomsTitle(ctx), datesTitle(ctx)].filter(Boolean).join(' · ')
  const flagged = report.users.length > 0
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="${Bun.escapeHTML(report.tool)}">
<title>${Bun.escapeHTML(`${title} · Rinnegan 独轮车检测`)}</title>
<style>
${STYLE}</style>
<noscript><style>.chart { display: none; }</style></noscript>
</head>
<body>
${MASK_SWITCH}
${header(ctx)}
<main class="wrap">
${tiles(ctx)}
${flagged ? timelines(ctx) : '<section><p class="empty">没有发现独轮车或可疑用户。</p></section>'}
${group(ctx, 'spam')}
${group(ctx, 'suspect')}
${manualBlends(ctx)}
${notes(ctx)}
</main>
<div id="tip" role="tooltip" hidden></div>
<script type="application/json" id="report-data">${JSON.stringify(clientData(ctx)).replace(/</g, '\\u003c')}</script>
<script>
${SCRIPT}</script>
</body>
</html>
`
}

/** Who was streaming, from the streamer's own danmaku when there is one. */
function roomsTitle({ report, activity }: Context): string {
  const names = report.archive.rooms.map(room => activity.hosts.get(room) ?? `直播间 ${room}`)
  if (names.length === 0) return '直播间'
  return names.length <= 2 ? names.join('、') : `${names.length} 个直播间`
}

function datesTitle({ report }: Context): string {
  const { messages, from, to } = report.archive
  if (messages === 0) return ''
  const start = localDate(from)
  if (start === localDate(to)) return start
  return `${start} – ${sameYear(from, to) ? monthDay(to) : localDate(to)}`
}

function header(ctx: Context): string {
  const { report, activity, options } = ctx
  const { archive } = report
  const dates = datesTitle(ctx)
  const rooms = archive.rooms.map(room => {
    const host = activity.hosts.get(room)
    return link(`https://live.bilibili.com/${room}`, `${host ? `${Bun.escapeHTML(host)} ` : ''}${room}`)
  })
  const skipped = Object.entries(archive.skipped).map(
    ([reason, n]) => `${SKIP_LABELS[reason as SkipReason] ?? reason} ${count(n)}`
  )
  const rows: [string, string][] = [
    ['归档', `${options.archives.map(name => Bun.escapeHTML(name)).join('<br>')}（${Bun.escapeHTML(archive.format)}）`],
  ]
  if (rooms.length > 0) rows.push(['房间', rooms.join('、')])
  if (archive.messages > 0) {
    rows.push([
      '时间',
      `${dateTime(archive.from)} → ${dateTime(archive.to)}（${utcOffsets(archive.from, archive.to)}）`,
    ])
  }
  rows.push(['弹幕', `${count(archive.messages)} 条，${count(archive.users)} 名用户`])
  if (skipped.length > 0) rows.push(['未计入', Bun.escapeHTML(skipped.join(' · '))])
  rows.push(['生成', `${dateTime(Date.parse(report.generatedAt))} · ${Bun.escapeHTML(report.tool)}`])
  return `<header class="top wrap">
<p class="eyebrow">LAPLACE Rinnegan 輪廻眼 · 离线检测报告</p>
<h1>${Bun.escapeHTML(roomsTitle(ctx))}${dates ? ` ${nowrap(`· ${dates}`)}` : ''}</h1>
<p class="lede">回放 LAPLACE Chat 弹幕归档，找出用工具刷屏的独轮车。每位被标记的用户都附有判定证据、发送间隔和弹幕样本；大多在复读别人的观众另列为手动融入。</p>
<dl class="meta">${rows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join('')}</dl>
</header>`
}

/** `循环独轮车 2 · 模板轮播 1`, most common first. */
function patternMix(users: readonly ReportUser[]): string {
  const counts = new Map<Pattern, number>()
  for (const user of users) counts.set(user.pattern, (counts.get(user.pattern) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, n]) => nowrap(`${PATTERN_LABELS[pattern]} ${n}`))
    .join(' · ')
}

/** `sub` and `mix` are Rinnegan's own words, so no escaping. */
function tile(kind: keyof typeof TILE_LABELS, n: number, sub: string, mix = ''): string {
  return `<div class="tile"><span class="num">${count(n)}</span><span class="lbl"><i class="dot ${kind}"></i>${TILE_LABELS[kind]}</span><span class="sub">${sub}</span>${mix ? `<span class="mix">${mix}</span>` : ''}</div>`
}

/** `其中 2 人也被判为可疑`, for 手动融入 viewers the detector flagged as well. */
function alsoFlagged(users: readonly ReportUser[]): string {
  const marked = users.filter(user => user.manualBlend)
  if (marked.length === 0) return ''
  const verdicts = [...new Set(marked.map(user => VERDICT_LABELS[user.verdict]))]
  return `其中 ${marked.length} 人也被判为${verdicts.join('或')}`
}

function tiles({ report }: Context): string {
  const spam = report.users.filter(user => user.verdict === 'spam')
  const suspects = report.users.filter(user => user.verdict === 'suspect')
  const exempt = spam.filter(user => user.exempt).length
  const banned = exempt > 0 ? `实时模式默认封禁 ${spam.length - exempt} 人，豁免 ${exempt} 人` : '实时模式默认封禁'
  // `archive.users` counts uids across rooms
  const listed = new Set([...report.users, ...report.manualBlends].map(user => user.uid)).size
  return `<section class="tiles" aria-label="检测结果">
${tile('spam', spam.length, banned, patternMix(spam))}
${tile('suspect', suspects.length, '默认只报告，不封禁', patternMix(suspects))}
${tile('manual', report.manualBlends.length, '大多在复读别人，只标记，不处置', alsoFlagged(report.users))}
${tile('none', Math.max(0, report.archive.users - listed), '未被标记的用户')}
</section>`
}

function timelines({ report, activity, at }: Context): string {
  if (activity.periods.length === 0) return ''
  const room = roomScope(report)
  const figures = activity.periods.map((period, i) => {
    const range = at.line().range(period.from, period.to)
    const peak = Math.max(0, ...period.counts)
    return `<figure class="fig">
<div class="fig-h"><h3>${range}</h3><p class="sub">${period.lanes.length} 名被标记用户 · ${room}峰值 ${count(peak)} ${perBucket(period.bucketMs)}</p></div>
<div class="chart" data-period="${i}" data-label="${Bun.escapeHTML(`${range} 的弹幕时间线`)}"></div>
</figure>`
  })
  return `<section aria-labelledby="h-time">
<h2 id="h-time">活跃时段</h2>
<p class="sec-intro">每段标记前后 ${TIMELINE_CONTEXT_MS / 60_000} 分钟内的弹幕。顶部是${room}的弹幕量；每行一名被标记用户，竖线是其弹幕（越深越密集），下方色条是被判为独轮车或可疑的时段。点击用户名跳到详情。</p>
<div class="legend"><span><i class="swatch-area"></i>${room}弹幕量</span><span><i class="swatch-tick"></i>该用户的弹幕</span><span><i class="swatch-bar spam"></i>${VERDICT_LABELS.spam}</span><span><i class="swatch-bar suspect"></i>${VERDICT_LABELS.suspect}</span></div>
${figures.join('\n')}
</section>`
}

function group(ctx: Context, verdict: 'spam' | 'suspect'): string {
  const users = ctx.report.users.filter(user => user.verdict === verdict)
  if (users.length === 0) return ''
  const { spamScore, suspectScore, minAutomation } = ctx.report.detector
  const intro =
    verdict === 'spam'
      ? `分数 ≥ ${spamScore} 且自动化证据 ≥ ${minAutomation}。实时模式会封禁这些用户，豁免者除外；AI 复核设为 confirm 时，须 AI 同意才封禁。`
      : `分数 ≥ ${suspectScore}，但未达到独轮车标准（分数 ≥ ${spamScore} 且自动化证据 ≥ ${minAutomation}）。默认只报告，不封禁；AI 复核设为 assist 时，高分且有部分自动化证据者会交给 AI 复核，AI 同意才封禁。`
  return `<section aria-labelledby="h-${verdict}">
<h2 id="h-${verdict}">${VERDICT_LABELS[verdict]} · ${users.length} 人</h2>
<p class="sec-intro">${intro}</p>
<div class="cards">
${users.map(user => card(ctx, user)).join('\n')}
</div>
</section>`
}

function card(ctx: Context, user: ReportUser): string {
  const gaps = ctx.activity.gaps.get(userKey(user))
  return `<article class="card" id="${cardId(user)}">
<div class="card-h">
${who(ctx, user, `<span class="rank">#${user.rank}</span>`)}
<span class="pill ${user.verdict}">${VERDICT_LABELS[user.verdict]} ${formatScore(user.score)}</span>
</div>
<p class="facts">${facts(ctx, user)}</p>
${partsOf(ctx, user)}
${user.exempt ? `<p class="exempt"><b>豁免</b>实时模式不会封禁：${Bun.escapeHTML(user.exempt)}</p>` : ''}
${manualNote(ctx, user)}
${evidence(user)}
${gaps ? gapFigure(user, gaps) : ''}
${lines(ctx, user)}
${allDanmaku(ctx, user)}
</article>`
}

/** Name, UID link and badges, after the `rank` markup when there is one. */
function who({ activity }: Context, user: { roomId: number; uid: number; uname: string }, rank = ''): string {
  const uid = link(`https://space.bilibili.com/${user.uid}`, `UID ${pii(String(user.uid))}`, 'uid')
  return `<div class="who">${rank}<h3 class="pii">${Bun.escapeHTML(nameOf(user))}</h3>${uid}${badges(activity.badges.get(userKey(user)))}</div>`
}

/** A flagged user's 手动融入 mark, linking to their entry in that list. */
function manualNote({ manualByKey }: Context, user: ReportUser): string {
  const entry = manualByKey.get(userKey(user))
  if (!entry) return ''
  return `<p class="manual-note"><a href="#${manualId(entry.n)}"><b>手动融入</b></a>也在手动复读别人：${copied(entry.blend)}</p>`
}

/** What earned the 手动融入 mark: copies among the text danmaku the tally counted. */
function copied(blend: ManualBlend): string {
  return `${count(blend.sends)} 条文字弹幕中复读了 ${count(blend.copies)} 条`
}

function badges(found: Badges | undefined): string {
  if (!found) return ''
  const out: string[] = []
  for (const label of [USER_TYPE_LABELS[found.userType], GUARD_LABELS[found.guardType]]) {
    if (label) out.push(`<span class="badge">${label}</span>`)
  }
  if (found.medalLevel > 0) {
    const name = Bun.escapeHTML(found.medalName || '粉丝牌')
    out.push(`<span class="medal" title="粉丝牌"><span>${name}</span><b>${found.medalLevel}</b></span>`)
  }
  return out.join('')
}

/** Pattern, volume and flagged times; only Rinnegan's own words and numbers, so no escaping. */
function facts({ report, at }: Context, user: ReportUser): string {
  const parts = [PATTERN_LABELS[user.pattern], `${count(user.messages)} 条弹幕`, repeatsText(user)]
  if (report.archive.rooms.length > 1) parts.unshift(`房间 ${user.roomId}`)
  const line = at.line()
  const first = user.episodes[0]
  const last = user.episodes[user.episodes.length - 1]
  if (first && last) {
    let flagged = `标记 ${nowrap(line.range(first.startAt, last.endAt))}`
    if (user.episodes.length > 1) flagged += `，共 ${user.episodes.length} 段`
    const spam = user.episodes.filter(episode => episode.verdict === 'spam')
    if (spam.length > 0 && spam.length < user.episodes.length) {
      const shown = spam.slice(0, 4).map(episode => nowrap(line.range(episode.startAt, episode.endAt)))
      flagged += `，独轮车 ${shown.join('、')}${spam.length > shown.length ? ` 等 ${spam.length} 段` : ''}`
    }
    parts.push(flagged)
  }
  parts.push(`峰值 ${nowrap(line.minute(user.peakAt))}`)
  return parts.join(' · ')
}

function evidence(user: ReportUser): string {
  if (user.evidence.length === 0) return ''
  const items = user.evidence.map(
    item =>
      `<li><span class="ev-l">${EVIDENCE_LABELS[item.kind]}</span><span class="ev-w">${item.weight.toFixed(2)}</span><span class="ev-d">${named(item.detail, item.names)}</span></li>`
  )
  return `<ul class="evidence">${items.join('')}</ul>`
}

/** Seconds as a viewer would say them: `1.2`, or `31` from 10 s up. */
function seconds(ms: number): string {
  return ms < 9950 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))
}

/** `1.1–2.0 秒`, or `6.3 秒左右` when both ends round alike. */
function secondsRange([from, to]: readonly [number, number]): string {
  const [a, b] = [seconds(from), seconds(to)]
  return a === b ? `${a} 秒左右` : `${a}–${b} 秒`
}

/** How far apart the user's danmaku were, in words a streamer reads without a key. */
function gapFigure(user: ReportUser, gaps: GapHistogram): string {
  const caption = [
    '柱子越高，和上一条隔这么久的弹幕越多。手动发弹幕时快时慢，柱子会摊成一片；工具定时发送，间隔几乎一样，柱子会挤成又高又窄的几根。',
  ]
  if (user.pattern === 'blend') caption.push('跟风机器人跟着房间里的热门内容发，间隔随大家而变，不一定整齐。')
  if (gaps.over > 0) caption.push(`另有 ${count(gaps.over)} 条和上一条隔了 ${gaps.max} 秒以上，没有画出。`)
  return `<figure class="fig inset">
<div class="fig-h"><h4>隔多久发一条</h4><p class="sub">一半的弹幕和上一条隔 <strong>${secondsRange(gaps.half)}</strong></p></div>
<div class="chart" data-gaps="${userKey(user)}" data-label="隔多久发一条"></div>
<figcaption>${caption.join('')}</figcaption>
</figure>`
}

/** One danmaku in a list; `note` is markup that follows the text. No `datetime`: lists run to tens of thousands of rows. */
function row(at: Clock, ms: number, text: string, note = ''): string {
  return `<li><time>${at.second(ms)}</time><span>${danmaku(text)}${note}</span></li>`
}

/** A note after a danmaku, led by a dot in its part's color; `html` is markup. */
function via(html: string, part: Part): string {
  return `<span class="via ${part}">${html}</span>`
}

/** Rows behind a summary, closed until clicked; nothing without rows. */
function collapsed(summary: string, rows: readonly string[]): string {
  if (rows.length === 0) return ''
  return `<details class="all"><summary>${summary}</summary><ol class="samples">${rows.join('')}</ol></details>`
}

/** Each line's summary opens its samples. */
function lines({ at }: Context, user: ReportUser): string {
  if (user.clusters.length === 0) return ''
  const blocks = user.clusters.map(cluster => {
    const stats = [`${cluster.variants} 种写法`]
    if (cluster.medianGapMs > 0) stats.push(`中位间隔 ${formatGap(cluster.medianGapMs)}`)
    if (cluster.crowd > 0) stats.push(`同时 ${cluster.crowd} 人在刷`)
    const head = `<b>「${danmaku(clip(cluster.key, 60, '…'))}」</b>×${cluster.count} · ${stats.join(' · ')}`
    const rows = cluster.samples.map(sample => row(at, sample.timestamp, sample.text))
    if (rows.length === 0) return `<p class="line-k">${head}</p>`
    return `<details class="line"><summary class="line-k">${head}</summary><ol class="samples">${rows.join('')}</ol></details>`
  })
  return `<div class="lines">${blocks.join('')}</div>`
}

/** Every danmaku the user sent in the archive, tagged with its part when the 手动融入 tally was kept. */
function allDanmaku({ activity, at }: Context, user: { roomId: number; uid: number }): string {
  const sent = activity.danmaku.get(userKey(user)) ?? []
  const tags = activity.tallies.get(userKey(user))
  const rows = sent.map(message => {
    const send = tags?.get(message)
    if (send) return row(at, message.timestamp, message.text, tally(send))
    const kind = leftOutKind(message)
    // Without the tally, a lone short reaction can't be told from any other line
    const note = kind === 'short' && !tags ? '' : via(LEFT_OUT[kind], 'other')
    return row(at, message.timestamp, message.text, note)
  })
  return collapsed(`全部 ${count(rows.length)} 条弹幕`, rows)
}

function manualBlends(ctx: Context): string {
  const blends = ctx.report.manualBlends
  if (blends.length === 0) return ''
  return `<section aria-labelledby="h-manual">
<h2 id="h-manual">手动融入 · ${blends.length} 人</h2>
<p class="sec-intro">弹幕大多是复读别人（跟队形或 +1），也会自己说话，看不出用了工具。只标记，不处置：实时模式不会因此封禁或豁免任何人。按复读条数排序。</p>
<ol class="manual">
${blends.map((blend, i) => manualEntry(ctx, blend, i + 1)).join('\n')}
</ol>
</section>`
}

/** The `n`th viewer in the 手动融入 list. */
function manualEntry(ctx: Context, blend: ManualBlend, n: number): string {
  const { report, flaggedByKey } = ctx
  const user = flaggedByKey.get(userKey(blend))
  const pill = user
    ? `<a class="pill ${user.verdict}" href="#${cardId(user)}">${VERDICT_LABELS[user.verdict]} ${formatScore(user.score)}</a>`
    : ''
  const room = report.archive.rooms.length > 1 ? `房间 ${blend.roomId} · ` : ''
  return `<li id="${manualId(n)}">
<div class="card-h">${who(ctx, blend)}${pill}</div>
${partsOf(ctx, blend)}
<p class="facts">${room}${copied(blend)}</p>
${allDanmaku(ctx, blend)}
</li>`
}

/** How a counted send was made, marked in its part's color. */
function tally(send: TalliedSend): string {
  const kind = sendKind(send)
  return via(kind === 'own' ? COUNTED.own : copyNote(send, from => pii(Bun.escapeHTML(from))), kind)
}

/** The user's danmaku split into parts, when the 手动融入 tally was kept for them. */
function partsOf({ activity }: Context, user: { roomId: number; uid: number }): string {
  const mix = activity.mixes.get(userKey(user))
  return mix ? partsBar(mix) : ''
}

/**
 * A bar splitting the danmaku into chants, +1s, lines of their own and, in gray, the kinds the tally leaves out, over
 * a legend naming and counting each; hovering or tapping a part says what it holds.
 */
function partsBar({ counts, sources, lagMs }: DanmakuMix): string {
  const counted = (part: CountedKind, ...notes: string[]): BarPart => ({
    part,
    name: COUNTED[part],
    n: counts[part],
    notes,
  })
  const leftOut = (Object.keys(LEFT_OUT) as LeftOutKind[]).filter(kind => counts[kind] > 0)
  const all: BarPart[] = [
    counted('chant', '复读前一分钟内 3 人以上在刷的内容'),
    counted(
      'plus-one',
      '复读一两个人刚发的内容',
      ...(lagMs === null ? [] : [`来自 ${sources} 人，通常比原弹幕晚 ${formatGap(lagMs)}`])
    ),
    counted('own', '前一分钟内没有其他人发过的内容'),
    {
      part: 'other',
      name: ZH_LIST.format(leftOut.map(kind => LEFT_OUT[kind])),
      n: leftOut.reduce((sum, kind) => sum + counts[kind], 0),
      notes: [
        ...(leftOut.length > 1 ? [leftOut.map(kind => `${LEFT_OUT[kind]} ${count(counts[kind])} 条`).join(' · ')] : []),
        '单独发的短句（如「？」）、表情和 @ 回复不算复读，也不算自己说的',
      ],
    },
  ]
  const parts = all.filter(item => item.n > 0)
  const total = parts.reduce((sum, item) => sum + item.n, 0)
  if (total === 0) return ''
  const share = (n: number) => (n < total / 100 ? '<1%' : `${Math.round((n / total) * 100)}%`)
  // A part's segment and legend entry share one tooltip: a headline over what the part holds
  const tip = ({ name, n, notes }: BarPart) =>
    `data-tip="${Bun.escapeHTML(`${name} · ${count(n)} 条 · 占 ${share(n)}`)}" data-tip-note="${Bun.escapeHTML(notes.join('\n'))}"`
  const bar = parts.map(item => `<i class="${item.part}" style="flex-grow:${item.n}" ${tip(item)}></i>`).join('')
  const legend = parts.map(item => {
    // The gray part counts each kind it holds
    const key =
      item.part === 'other'
        ? leftOut.map(kind => `<span>${LEFT_OUT[kind]}<b>${count(counts[kind])}</b></span>`).join('·')
        : `${item.name}<b>${count(item.n)}</b>`
    return `<span ${tip(item)}><i class="swatch-seg ${item.part}"></i>${key}</span>`
  })
  const label = parts.map(item => `${item.name} ${count(item.n)} 条（${share(item.n)}）`).join('，')
  return `<div class="parts"><div class="parts-bar" role="img" aria-label="${Bun.escapeHTML(`${count(total)} 条弹幕：${label}`)}">${bar}</div><p class="legend parts-key">${legend.join('')}</p></div>`
}

function notes({ report }: Context): string {
  const { windowMs, spamScore, suspectScore, minAutomation } = report.detector
  const generatedAt = Date.parse(report.generatedAt)
  return `<section aria-labelledby="h-notes" class="foot">
<h2 id="h-notes">说明</h2>
<p>分数 0–100，由 ${windowMs / 60_000} 分钟检测窗口内的重复次数与自动化证据（不可见字符、固定节拍、发送节拍、模板轮播、跟风触发、多号同步等）算出。分数 ≥ ${spamScore} 且自动化证据 ≥ ${minAutomation} 判为独轮车，≥ ${suspectScore} 为可疑；单纯的重复（刷屏量）不算自动化证据。</p>
<p>每位用户的模式、证据和样本取自其分数最高的时刻，点开每条内容可看样本；标记时段是分数保持在可疑及以上的连续时间。工具插入的不可见字符显示为 ${chip('U+00AD')} 这样的编号。</p>
<p>色条是用户在归档里全部弹幕的构成：跟队形、+1、自己说的，灰色部分是单独发的短句（如「？」）、表情和 @ 回复，不算复读也不算自己说的。悬停或点按色条可看每部分的说明；点开「全部弹幕」可看其发的每一条，各自标出属于哪一部分。</p>
<p>手动融入按整场统计，不看检测窗口：文字弹幕大多是复读别人刚发过的内容，换内容时也常换成自己说的，且整场没出现用工具的迹象；单独发的短句（如「？」「哈哈哈」）、表情和 @ 回复不计入。</p>
<p>右下角的「打码」会模糊观众的用户名和 UID（主播名和房间号照常显示），方便截图分享。它只改变显示，用户名和 UID 仍在 HTML 文件里，直接分享文件就等于分享全部内容。</p>
<p>时间为 ${report.archive.messages > 0 ? utcOffsets(report.archive.from, report.archive.to) : utcOffset(generatedAt)}。本报告是单个 HTML 文件，离线也能打开。由 ${link(REPO_URL, Bun.escapeHTML(report.tool))} 生成于 ${dateTime(generatedAt)}。</p>
</section>`
}

/** A lane's tooltip after the name, which the chart script shows apart so 打码 can blur it. */
function laneTip(lane: Lane, at: Clock): string {
  const first = lane.sends[0]
  const last = lane.sends.at(-1)
  if (first === undefined || last === undefined) return '本时段没有弹幕'
  return `本时段 ${count(lane.sends.length)} 条弹幕 · ${at.line().range(first, last)}`
}

/** What the chart script draws; times are seconds from each period's start. */
function clientData({ report, activity, at, flaggedByKey }: Context) {
  return {
    room: roomScope(report),
    periods: activity.periods.map(period => {
      const offset = (ms: number) => Math.round((Math.min(Math.max(ms, period.from), period.to) - period.from) / 1000)
      return {
        span: (period.to - period.from) / 1000,
        bucket: period.bucketMs / 1000,
        unit: perBucket(period.bucketMs),
        counts: period.counts,
        ticks: period.ticks.map(tick => [(tick.at - period.from) / 1000, tick.label]),
        lanes: period.lanes.map(lane => {
          const user = flaggedByKey.get(userKey(lane))
          return {
            href: user ? `#${cardId(user)}` : '#',
            name: nameOf(lane),
            sends: lane.sends.map(offset),
            flagged: lane.episodes.map(episode => [offset(episode.startAt), offset(episode.endAt), episode.verdict]),
            tip: laneTip(lane, at),
          }
        }),
      }
    }),
    gaps: Object.fromEntries(
      [...activity.gaps].map(([key, gaps]) => [key, { max: gaps.max, bin: gaps.binMs / 1000, counts: gaps.counts }])
    ),
  }
}

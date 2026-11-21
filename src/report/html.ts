import type { Activity, Badges, GapHistogram, Lane } from '@/report/activity'
import type { OfflineReport, ReportUser } from '@/report/report'
import type { SkipReason } from '@/sources/events'
import type { Pattern } from '@/types'

import { clip, escapeInvisible } from '@/detect/normalize'
import { TIMELINE_CONTEXT_MS, userKey } from '@/report/activity'
import { EVIDENCE_LABELS, GUARD_LABELS, PATTERN_LABELS, SKIP_LABELS, VERDICT_LABELS } from '@/report/labels'
import SCRIPT from '@/report/page/script.js' with { type: 'text' }
import STYLE from '@/report/page/style.css' with { type: 'text' }
import { formatGap, formatScore } from '@/report/report'
import { clock, count, dateTime, localDate, utcOffset, utcOffsets } from '@/util/console'

export interface HtmlOptions {
  /** Archive file names for the header; never full paths, which can name the local user */
  archives: string[]
  /** Samples shown per line */
  samples: number
}

const REPO_URL = 'https://github.com/laplace-live/rinnegan'
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
/** A run of one chip from {@link danmaku} */
const CHIP_RUN_RE = /(<span class="cp">U\+[0-9A-F]{4,6}<\/span>)\1*/g

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
}

/** Text safe for HTML content and quoted attributes. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char] ?? char)
}

function chip(label: string): string {
  return `<span class="cp">${label}</span>`
}

/** Escaped danmaku with tool-inserted invisible chars as `U+00AD` chips; a run of one char collapses to `×n`. */
function danmaku(text: string): string {
  // Escaped first, so only chips match CHIP_RUN_RE: text that merely reads `⟨U+00AD⟩` stays text.
  return escapeInvisible(escapeHtml(text), chip).replace(CHIP_RUN_RE, (run: string, one: string) => {
    const times = run.length / one.length
    return times > 1 ? one.replace('</span>', ` ×${times}</span>`) : one
  })
}

/** Local times, dated only when the archive spans more than one day. */
function clockFor(from: number, to: number): Clock {
  const dated = localDate(from) !== localDate(to)
  const sameYear = localDate(from).slice(0, 4) === localDate(to).slice(0, 4)
  const day = (ms: number) => (sameYear ? localDate(ms).slice(5) : localDate(ms))
  return {
    second: ms => (dated ? `${day(ms)} ${clock(ms)}` : clock(ms)),
    line: () => {
      let shown = ''
      const minute = (ms: number) => {
        const date = localDate(ms)
        const prefix = dated && date !== shown ? `${day(ms)} ` : ''
        shown = date
        return `${prefix}${clock(ms).slice(0, 5)}`
      }
      return {
        minute,
        range: (a, b) => {
          const start = minute(a)
          if (localDate(a) !== localDate(b)) return `${start} – ${minute(b)}`
          const end = clock(b).slice(0, 5)
          return end === clock(a).slice(0, 5) ? start : `${start}–${end}`
        },
      }
    },
  }
}

function nowrap(html: string): string {
  return `<span class="nowrap">${html}</span>`
}

function cardId(user: { roomId: number; uid: number }): string {
  return `u-${user.roomId}-${user.uid}`
}

function nameOf(user: { uname: string }): string {
  return user.uname || '(无名)'
}

/** What the room-wide traffic line counts. */
function roomScope(report: OfflineReport): string {
  return report.archive.rooms.length > 1 ? '所有房间' : '全房间'
}

function link(href: string, html: string, cls = ''): string {
  return `<a${cls ? ` class="${cls}"` : ''} href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`
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
  const ctx: Context = { report, activity, options, at: clockFor(report.archive.from, report.archive.to) }
  const title = [roomsTitle(ctx), datesTitle(ctx)].filter(Boolean).join(' · ')
  const flagged = report.users.length > 0
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="${escapeHtml(report.tool)}">
<title>${escapeHtml(`${title} · Rinnegan 独轮车检测`)}</title>
<style>
${STYLE}</style>
<noscript><style>.chart { display: none; }</style></noscript>
</head>
<body>
${header(ctx)}
<main class="wrap">
${tiles(ctx)}
${flagged ? timelines(ctx) : '<section><p class="empty">没有发现独轮车或可疑用户。</p></section>'}
${group(ctx, 'spam')}
${group(ctx, 'suspect')}
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
  const end = localDate(to)
  if (start === end) return start
  return `${start} – ${start.slice(0, 4) === end.slice(0, 4) ? end.slice(5) : end}`
}

function header(ctx: Context): string {
  const { report, activity, options } = ctx
  const { archive } = report
  const dates = datesTitle(ctx)
  const rooms = archive.rooms.map(room => {
    const host = activity.hosts.get(room)
    return link(`https://live.bilibili.com/${room}`, `${host ? `${escapeHtml(host)} ` : ''}${room}`)
  })
  const skipped = Object.entries(archive.skipped).map(
    ([reason, n]) => `${SKIP_LABELS[reason as SkipReason] ?? reason} ${count(n)}`
  )
  const rows: [string, string][] = [
    ['归档', `${options.archives.map(escapeHtml).join('<br>')}（${escapeHtml(archive.format)}）`],
  ]
  if (rooms.length > 0) rows.push(['房间', rooms.join('、')])
  if (archive.messages > 0) {
    rows.push([
      '时间',
      `${dateTime(archive.from)} → ${dateTime(archive.to)}（${utcOffsets(archive.from, archive.to)}）`,
    ])
  }
  rows.push(['弹幕', `${count(archive.messages)} 条，${count(archive.users)} 名用户`])
  if (skipped.length > 0) rows.push(['未计入', escapeHtml(skipped.join(' · '))])
  rows.push(['生成', `${dateTime(Date.parse(report.generatedAt))} · ${escapeHtml(report.tool)}`])
  return `<header class="top wrap">
<p class="eyebrow">LAPLACE Rinnegan 輪廻眼 · 离线检测报告</p>
<h1>${escapeHtml(roomsTitle(ctx))}${dates ? ` ${nowrap(`· ${dates}`)}` : ''}</h1>
<p class="lede">回放 LAPLACE Chat 弹幕归档，找出用工具循环刷屏的独轮车。每位被标记的用户都附有判定证据、发送间隔和弹幕样本。</p>
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

function tile(dot: string, n: number, label: string, sub: string, mix = ''): string {
  return `<div class="tile"><span class="num">${count(n)}</span><span class="lbl"><i class="dot ${dot}"></i>${label}</span><span class="sub">${sub}</span>${mix ? `<span class="mix">${mix}</span>` : ''}</div>`
}

function tiles({ report }: Context): string {
  const spam = report.users.filter(user => user.verdict === 'spam')
  const suspects = report.users.filter(user => user.verdict === 'suspect')
  const exempt = spam.filter(user => user.exempt).length
  const banned = exempt > 0 ? `实时模式默认封禁 ${spam.length - exempt} 人，豁免 ${exempt} 人` : '实时模式默认封禁'
  // `archive.users` counts uids across rooms
  const unflagged = report.archive.users - new Set(report.users.map(user => user.uid)).size
  return `<section class="tiles" aria-label="检测结果">
${tile('spam', spam.length, '独轮车', banned, patternMix(spam))}
${tile('suspect', suspects.length, '可疑', '默认只报告，不封禁', patternMix(suspects))}
${tile('none', Math.max(0, unflagged), '正常', '未被标记的用户')}
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
<div class="chart" data-period="${i}" data-label="${escapeHtml(`${range} 的弹幕时间线`)}"></div>
</figure>`
  })
  return `<section aria-labelledby="h-time">
<h2 id="h-time">活跃时段</h2>
<p class="sec-intro">每段标记前后 ${TIMELINE_CONTEXT_MS / 60_000} 分钟内的弹幕。顶部是${room}的弹幕量；每行一名被标记用户，竖线是其弹幕（越深越密集），下方色条是被判为独轮车或可疑的时段。点击用户名跳到详情。</p>
<div class="legend"><span><i class="swatch-area"></i>${room}弹幕量</span><span><i class="swatch-tick"></i>该用户的弹幕</span><span><i class="swatch-bar spam"></i>独轮车</span><span><i class="swatch-bar suspect"></i>可疑</span></div>
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
  const key = userKey(user)
  const gaps = ctx.activity.gaps.get(key)
  const uid = link(`https://space.bilibili.com/${user.uid}`, `UID ${user.uid}`, 'uid')
  return `<article class="card" id="${cardId(user)}">
<div class="card-h">
<div class="who"><span class="rank">#${user.rank}</span><h3>${escapeHtml(nameOf(user))}</h3>${uid}${badges(ctx.activity.badges.get(key))}</div>
<span class="pill ${user.verdict}">${VERDICT_LABELS[user.verdict]} ${formatScore(user.score)}</span>
</div>
<p class="facts">${facts(ctx, user)}</p>
${user.exempt ? `<p class="exempt"><b>豁免</b>实时模式不会封禁：${escapeHtml(user.exempt)}</p>` : ''}
${evidence(user)}
${gaps ? gapFigure(user, gaps) : ''}
${lines(ctx, user)}
</article>`
}

function badges(found: Badges | undefined): string {
  if (!found) return ''
  const out: string[] = []
  if (found.userType === 100) out.push('<span class="badge">主播</span>')
  else if (found.userType === 1) out.push('<span class="badge">房管</span>')
  const guard = GUARD_LABELS[found.guardType]
  if (guard) out.push(`<span class="badge">${guard}</span>`)
  if (found.medalLevel > 0) {
    const name = escapeHtml(found.medalName || '粉丝牌')
    out.push(`<span class="medal" title="粉丝牌"><span>${name}</span><b>${found.medalLevel}</b></span>`)
  }
  return out.join('')
}

/** Pattern, volume and flagged times; only Rinnegan's own words and numbers, so no escaping. */
function facts({ report, at }: Context, user: ReportUser): string {
  const parts = [
    PATTERN_LABELS[user.pattern],
    `${count(user.messages)} 条弹幕`,
    `${user.triggerHits ? '跟风命中' : '窗口内重复'} ${user.repeats} 次`,
  ]
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
      `<li><span class="ev-l">${EVIDENCE_LABELS[item.kind]}</span><span class="ev-w">${item.weight.toFixed(2)}</span><span class="ev-d">${danmaku(item.detail)}</span></li>`
  )
  return `<ul class="evidence">${items.join('')}</ul>`
}

function gapFigure(user: ReportUser, gaps: GapHistogram): string {
  const caption = [`相邻两条弹幕的间隔，0–${gaps.max} 秒，每格 ${gaps.binMs / 1000} 秒。`]
  if (gaps.tickMs) caption.push(`浅色竖线是 Rinnegan 拟合的 ${Math.round(gaps.tickMs / 10) / 100} 秒发送节拍的整数倍。`)
  if (gaps.over > 0) caption.push(`另有 ${count(gaps.over)} 个更长的间隔未显示。`)
  const label = escapeHtml(`${nameOf(user)} 的发送间隔分布`)
  return `<figure class="fig inset"><div class="chart" data-gaps="${userKey(user)}" data-label="${label}"></div><figcaption>${caption.join('')}</figcaption></figure>`
}

function lines({ options, at }: Context, user: ReportUser): string {
  if (user.clusters.length === 0) return ''
  const blocks = user.clusters.map(cluster => {
    const stats = [`${cluster.variants} 种写法`]
    if (cluster.medianGapMs > 0) stats.push(`中位间隔 ${formatGap(cluster.medianGapMs)}`)
    if (cluster.crowd > 0) stats.push(`同时 ${cluster.crowd} 人在刷`)
    const samples = cluster.samples
      .slice(0, options.samples)
      .map(
        sample =>
          `<li><time datetime="${new Date(sample.timestamp).toISOString()}">${at.second(sample.timestamp)}</time><span>${danmaku(sample.text)}</span></li>`
      )
    const list = samples.length > 0 ? `<ol class="samples">${samples.join('')}</ol>` : ''
    return `<div><p class="line-k"><b>「${danmaku(clip(cluster.key, 60, '…'))}」</b>×${cluster.count} · ${stats.join(' · ')}</p>${list}</div>`
  })
  return `<div class="lines">${blocks.join('')}</div>`
}

function notes({ report }: Context): string {
  const { windowMs, spamScore, suspectScore, minAutomation } = report.detector
  const generatedAt = Date.parse(report.generatedAt)
  return `<section aria-labelledby="h-notes" class="foot">
<h2 id="h-notes">说明</h2>
<p>分数 0–100，由 ${windowMs / 60_000} 分钟检测窗口内的重复次数与自动化证据（不可见字符、固定节拍、发送节拍、模板轮播、跟风触发等）算出。分数 ≥ ${spamScore} 且自动化证据 ≥ ${minAutomation} 判为独轮车，≥ ${suspectScore} 为可疑；单纯的重复（刷屏量）不算自动化证据。</p>
<p>每位用户的模式、证据和样本取自其分数最高的时刻；标记时段是分数保持在可疑及以上的连续时间。工具插入的不可见字符显示为 <span class="cp">U+00AD</span> 这样的编号。</p>
<p>时间为 ${report.archive.messages > 0 ? utcOffsets(report.archive.from, report.archive.to) : utcOffset(generatedAt)}。本报告是单个 HTML 文件，离线也能打开。由 ${link(REPO_URL, escapeHtml(report.tool))} 生成于 ${dateTime(generatedAt)}。</p>
</section>`
}

function laneTip(lane: Lane, at: Clock): string {
  const name = nameOf(lane)
  if (lane.firstAt === null || lane.lastAt === null) return `${name} · 本时段没有弹幕`
  return `${name} · 本时段 ${count(lane.sends.length)} 条弹幕 · ${at.line().range(lane.firstAt, lane.lastAt)}`
}

/** What the chart script draws; times are seconds from each period's start. */
function clientData({ report, activity, at }: Context) {
  return {
    room: roomScope(report),
    periods: activity.periods.map(period => ({
      span: (period.to - period.from) / 1000,
      bucket: period.bucketMs / 1000,
      unit: perBucket(period.bucketMs),
      counts: period.counts,
      ticks: period.ticks.map(tick => [(tick.at - period.from) / 1000, tick.label]),
      lanes: period.lanes.map(lane => ({
        href: `#${cardId(lane)}`,
        name: nameOf(lane),
        sends: lane.sends,
        flagged: lane.flagged,
        tip: laneTip(lane, at),
      })),
    })),
    gaps: Object.fromEntries(
      [...activity.gaps].map(([key, gaps]) => [
        key,
        {
          max: gaps.max,
          bin: gaps.binMs / 1000,
          counts: gaps.counts,
          tick: gaps.tickMs === null ? null : gaps.tickMs / 1000,
        },
      ])
    ),
  }
}

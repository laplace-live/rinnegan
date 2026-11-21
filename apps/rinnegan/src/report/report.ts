import type {
  ClusterSummary,
  CopySample,
  DetectorOptions,
  Episode,
  Evidence,
  ManualBlend,
  Pattern,
  UserSummary,
  Verdict,
} from '@laplace.live/rinnegan-sdk'
import { clip, EVIDENCE_LABELS, escapeInvisible, PATTERN_LABELS, VERDICT_LABELS } from '@laplace.live/rinnegan-sdk'

import { clock, count, dateTime, style, utcOffsets } from '@/util/console'

export interface ArchiveInfo {
  path: string
  format: string
  messages: number
  users: number
  rooms: number[]
  /** Unix ms of the first and last judged message */
  from: number
  to: number
  skipped: Record<string, number>
}

/** One flagged user in an offline report. */
export interface ReportUser {
  rank: number
  roomId: number
  uid: number
  uname: string
  verdict: Verdict
  score: number
  pattern: Pattern
  /** Excess repeats in the window at the peak, or 自动融入 line switches when {@link triggerHits} */
  repeats: number
  /** `repeats` counts 自动融入 line switches: trigger hits, or switches in step with another account */
  triggerHits: boolean
  automation: number
  /** Total messages this user sent in the archive */
  messages: number
  firstAt: number
  lastAt: number
  peakAt: number
  evidence: Evidence[]
  clusters: ClusterSummary[]
  episodes: Episode[]
  /** Why live mode would not ban this user, when it wouldn't */
  exempt: string | null
  /** Also marked 手动融入: mostly copies what others send, by hand */
  manualBlend: boolean
}

export interface OfflineReport {
  tool: string
  generatedAt: string
  archive: ArchiveInfo
  detector: DetectorOptions
  totals: { spam: number; suspect: number; manualBlend: number }
  users: ReportUser[]
  /** 手动融入: viewers who mostly copy what others send, by hand; never banned */
  manualBlends: ManualBlend[]
}

/** A user in one room, as `room:uid`. */
export function userKey(user: { roomId: number; uid: number }): string {
  return `${user.roomId}:${user.uid}`
}

export function nameOf(user: { uname: string }): string {
  return user.uname || '(无名)'
}

/** e.g. `窗口内重复 12 次` */
export function repeatsText(user: ReportUser): string {
  return `${user.triggerHits ? '跟风命中' : '窗口内重复'} ${user.repeats} 次`
}

export function buildReport(options: {
  archive: ArchiveInfo
  detector: DetectorOptions
  summaries: UserSummary[]
  manualBlends?: ManualBlend[]
  exemption?: (summary: UserSummary) => string | null
  version: string
}): OfflineReport {
  const manualBlends = options.manualBlends ?? []
  const marked = new Set(manualBlends.map(userKey))
  const users = options.summaries.map(
    (summary, index): ReportUser => ({
      rank: index + 1,
      roomId: summary.roomId,
      uid: summary.uid,
      uname: summary.uname,
      verdict: summary.peak.verdict,
      score: summary.peak.score,
      pattern: summary.peak.pattern,
      repeats: summary.peak.repeats,
      triggerHits: summary.peak.triggerHits ?? false,
      automation: summary.peak.automation,
      messages: summary.messages,
      firstAt: summary.firstAt,
      lastAt: summary.lastAt,
      peakAt: summary.peak.at,
      evidence: summary.peak.evidence,
      clusters: summary.peak.clusters,
      episodes: summary.episodes,
      exempt: options.exemption?.(summary) ?? null,
      manualBlend: marked.has(userKey(summary)),
    })
  )
  return {
    tool: `LAPLACE Rinnegan ${options.version}`,
    generatedAt: new Date().toISOString(),
    archive: options.archive,
    detector: options.detector,
    totals: {
      spam: users.filter(user => user.verdict === 'spam').length,
      suspect: users.filter(user => user.verdict === 'suspect').length,
      manualBlend: manualBlends.length,
    },
    users,
    manualBlends,
  }
}

/** Score with one decimal, `100` without. */
export function formatScore(score: number): string {
  return score.toFixed(score >= 99.95 ? 0 : 1)
}

/** Median gap as `1.3s`, `—` when there is none. */
export function formatGap(ms: number): string {
  return ms > 0 ? `${(ms / 1000).toFixed(1)}s` : '—'
}

function verdictBadge(verdict: Verdict, score: number): string {
  const text = `${VERDICT_LABELS[verdict]} ${formatScore(score)}`
  return verdict === 'spam' ? style.red(style.bold(text)) : style.yellow(text)
}

function range(from: number, to: number): string {
  const start = dateTime(from)
  const sameDay = start.slice(0, 10) === dateTime(to).slice(0, 10)
  return sameDay ? `${start}–${clock(to)}` : `${start} → ${dateTime(to)}`
}

/** Human-readable console rendering; `top` limits users per verdict. */
export function renderConsole(
  report: OfflineReport,
  options: { top: number; suspects: boolean; samples: number }
): string {
  const lines: string[] = []
  const { archive } = report
  lines.push(style.bold('LAPLACE Rinnegan 輪廻眼 · 离线检测'))
  lines.push(
    `归档 ${archive.path}（${archive.format}）· ${count(archive.messages)} 条弹幕 · ${count(archive.users)} 名用户 · 房间 ${archive.rooms.join(', ') || '—'}`
  )
  if (archive.messages > 0)
    lines.push(`时间 ${range(archive.from, archive.to)}（${utcOffsets(archive.from, archive.to)}）`)
  const skipped = Object.entries(archive.skipped)
  if (skipped.length) lines.push(style.gray(`跳过 ${skipped.map(([reason, n]) => `${reason} ${n}`).join(' · ')}`))
  lines.push('')
  lines.push(
    `${style.red(style.bold(`独轮车 ${report.totals.spam} 人`))} · ${style.yellow(`可疑 ${report.totals.suspect} 人`)} · ${style.cyan(`手动融入 ${report.totals.manualBlend} 人`)}`
  )

  const groups: [Verdict, ReportUser[]][] = [['spam', report.users.filter(user => user.verdict === 'spam')]]
  if (options.suspects) groups.push(['suspect', report.users.filter(user => user.verdict === 'suspect')])
  for (const [verdict, users] of groups) {
    if (users.length === 0) continue
    lines.push('')
    lines.push(
      style.bold(
        `── ${VERDICT_LABELS[verdict]}（按分数排序${users.length > options.top ? `，前 ${options.top} 名` : ''}）`
      )
    )
    for (const user of users.slice(0, options.top)) {
      lines.push('')
      lines.push(
        `#${user.rank} ${verdictBadge(user.verdict, user.score)}  ${style.bold(nameOf(user))} ${style.gray(`uid ${user.uid} · 房间 ${user.roomId}`)}${user.exempt ? style.cyan(` · 豁免：${user.exempt}`) : ''}${user.manualBlend ? style.cyan(' · 手动融入') : ''}`
      )
      lines.push(
        `   ${PATTERN_LABELS[user.pattern]} · ${repeatsText(user)} · 自动化 ${user.automation.toFixed(2)} · 共 ${count(user.messages)} 条 · ${user.episodes.length} 段 · 峰值 ${dateTime(user.peakAt)}`
      )
      for (const item of user.evidence) {
        lines.push(
          `   ${style.cyan(`· ${EVIDENCE_LABELS[item.kind]}`)} ${style.gray(item.weight.toFixed(2))} ${item.detail}`
        )
      }
      for (const cluster of user.clusters.slice(0, 2)) {
        lines.push(
          `   「${escapeInvisible(clip(cluster.key, 40))}」×${cluster.count} · ${cluster.variants} 种写法 · 中位间隔 ${formatGap(cluster.medianGapMs)}${cluster.crowd ? ` · 同时 ${cluster.crowd} 人在刷` : ''}`
        )
        for (const sample of cluster.samples.slice(0, options.samples)) {
          lines.push(style.gray(`      ${clock(sample.timestamp)}  ${escapeInvisible(sample.text)}`))
        }
      }
    }
  }

  const blends = report.manualBlends
  if (options.suspects && blends.length > 0) {
    lines.push('')
    lines.push(
      style.bold(
        `── 手动融入（弹幕多半是复读，也会自己说话，看不出用了工具；只标记，不处置${blends.length > options.top ? `；复读最多的前 ${options.top} 名` : ''}）`
      )
    )
    for (const blend of blends.slice(0, options.top)) {
      lines.push('')
      lines.push(`${style.bold(nameOf(blend))} ${style.gray(`uid ${blend.uid} · 房间 ${blend.roomId}`)}`)
      lines.push(`   ${describeCopying(blend)}`)
      for (const sample of blend.samples.slice(0, options.samples)) {
        lines.push(style.gray(`      ${clock(sample.at)}  ${copySample(sample)}`))
      }
    }
  }
  return lines.join('\n')
}

/** e.g. `复读 43/67 条（跟队形 18 条，+1 了 23 人的 25 条，通常比原弹幕晚 6.3s），自己说的 24 条` */
export function describeCopying(blend: ManualBlend): string {
  const parts: string[] = []
  if (blend.chants > 0) parts.push(`跟队形 ${blend.chants} 条`)
  const plusOnes = blend.copies - blend.chants
  if (plusOnes > 0) {
    const lag = blend.plusOneLagMs === null ? '' : `，通常比原弹幕晚 ${formatGap(blend.plusOneLagMs)}`
    parts.push(`+1 了 ${blend.sources} 人的 ${plusOnes} 条${lag}`)
  }
  return `复读 ${blend.copies}/${blend.sends} 条（${parts.join('，')}），自己说的 ${blend.sends - blend.copies} 条`
}

function plusOneCell(blend: ManualBlend): string {
  const plusOnes = blend.copies - blend.chants
  return plusOnes > 0 ? `${plusOnes}（${blend.sources} 人）` : '0'
}

/** How a copy was made: `跟 22 人一起刷`, or `复读 路人，晚 5.6s` for a +1, with `name` rendering whose line it was. */
export function copyNote(sample: CopySample, name: (from: string) => string = from => from): string {
  return 'from' in sample ? `复读 ${name(sample.from)}，晚 ${formatGap(sample.lagMs)}` : `跟 ${sample.senders} 人一起刷`
}

function copySample(sample: CopySample): string {
  return `「${escapeInvisible(clip(sample.text, 40))}」 ${copyNote(sample)}`
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** Markdown rendering with every flagged user, for sharing or archiving. */
export function renderMarkdown(report: OfflineReport): string {
  const { archive } = report
  const blends = new Map(report.manualBlends.map(blend => [userKey(blend), blend]))
  const out: string[] = []
  out.push('# LAPLACE Rinnegan 独轮车检测报告', '')
  out.push(`- 生成时间：${dateTime(Date.parse(report.generatedAt))}（${report.tool}）`)
  out.push(`- 归档：\`${archive.path}\`（${archive.format}）`)
  out.push(
    `- 弹幕：${count(archive.messages)} 条，${count(archive.users)} 名用户，房间 ${archive.rooms.join(', ') || '—'}`
  )
  if (archive.messages > 0)
    out.push(`- 时间：${range(archive.from, archive.to)}（${utcOffsets(archive.from, archive.to)}）`)
  out.push(
    `- 结果：独轮车 **${report.totals.spam}** 人，可疑 **${report.totals.suspect}** 人，手动融入 **${report.totals.manualBlend}** 人`,
    ''
  )
  out.push('| # | 判定 | 分数 | 用户 | UID | 模式 | 窗口重复 | 证据 | 主要内容 |')
  out.push('| -: | --- | -: | --- | -: | --- | -: | --- | --- |')
  for (const user of report.users) {
    const top = user.clusters[0]
    out.push(
      `| ${user.rank} | ${VERDICT_LABELS[user.verdict]}${tags(user)} | ${user.score} | ${cell(user.uname)} | ${user.uid} | ${PATTERN_LABELS[user.pattern]} | ${user.repeats}${user.triggerHits ? '（跟风命中）' : ''} | ${user.evidence.map(item => EVIDENCE_LABELS[item.kind]).join('、')} | ${top ? cell(`「${escapeInvisible(clip(top.key, 30))}」×${top.count}`) : ''} |`
    )
  }
  for (const user of report.users) {
    out.push(
      '',
      `## #${user.rank} ${cell(user.uname)}（${user.uid}）— ${VERDICT_LABELS[user.verdict]} ${user.score}`,
      ''
    )
    out.push(
      `- 房间 ${user.roomId}，${PATTERN_LABELS[user.pattern]}，峰值 ${dateTime(user.peakAt)}，共 ${user.messages} 条弹幕`
    )
    if (user.exempt) out.push(`- 豁免：${user.exempt}`)
    const blend = blends.get(userKey(user))
    if (blend) out.push(`- 手动融入：${describeCopying(blend)}`)
    for (const item of user.evidence)
      out.push(`- ${EVIDENCE_LABELS[item.kind]}（${item.weight}）：${cell(item.detail)}`)
    for (const episode of user.episodes) {
      out.push(
        `- 时段 ${range(episode.startAt, episode.endAt)}：${VERDICT_LABELS[episode.verdict]}，峰值 ${episode.peakScore}，「${cell(escapeInvisible(clip(episode.key, 30)))}」`
      )
    }
    for (const cluster of user.clusters) {
      out.push(
        '',
        `「${cell(escapeInvisible(cluster.key))}」×${cluster.count}，${cluster.variants} 种写法，中位间隔 ${formatGap(cluster.medianGapMs)}，同时 ${cluster.crowd} 人在刷`,
        ''
      )
      for (const sample of cluster.samples)
        out.push(`    ${dateTime(sample.timestamp)}  ${escapeInvisible(sample.text)}`)
    }
  }
  if (report.manualBlends.length > 0) {
    out.push('', '## 手动融入', '')
    out.push('弹幕多半是复读别人（跟队形或 +1），也会自己说话，看不出用了工具。只标记，不处置。', '')
    out.push('| # | 用户 | UID | 复读 | 跟队形 | +1 | 自己说的 | +1 通常晚 | 样本 |')
    out.push('| -: | --- | -: | -: | -: | -: | -: | -: | --- |')
    report.manualBlends.forEach((blend, index) => {
      const sample = blend.samples.at(-1)
      out.push(
        `| ${index + 1} | ${cell(blend.uname)} | ${blend.uid} | ${blend.copies}/${blend.sends} | ${blend.chants} | ${plusOneCell(blend)} | ${blend.sends - blend.copies} | ${formatGap(blend.plusOneLagMs ?? 0)} | ${sample ? cell(copySample(sample)) : ''} |`
      )
    })
  }
  return `${out.join('\n')}\n`
}

function tags(user: ReportUser): string {
  const found = [user.exempt ? '豁免' : '', user.manualBlend ? '手动融入' : ''].filter(Boolean)
  return found.length > 0 ? `（${found.join('、')}）` : ''
}

import type { DetectorOptions, Episode, UserSummary } from '@/detect/detector'
import type { ClusterSummary, Evidence, Pattern, Verdict } from '@/types'

import { escapeInvisible } from '@/detect/normalize'
import { EVIDENCE_LABELS, PATTERN_LABELS, VERDICT_LABELS } from '@/report/labels'
import { clock, count, dateTime, style } from '@/util/console'

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
  /** Excess repeats in the window at the peak */
  repeats: number
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
}

export interface OfflineReport {
  tool: string
  generatedAt: string
  archive: ArchiveInfo
  detector: DetectorOptions
  totals: { spam: number; suspect: number }
  users: ReportUser[]
}

export function buildReport(options: {
  archive: ArchiveInfo
  detector: DetectorOptions
  summaries: UserSummary[]
  exemption?: (summary: UserSummary) => string | null
  version: string
}): OfflineReport {
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
      automation: summary.peak.automation,
      messages: summary.messages,
      firstAt: summary.firstAt,
      lastAt: summary.lastAt,
      peakAt: summary.peak.at,
      evidence: summary.peak.evidence,
      clusters: summary.peak.clusters,
      episodes: summary.episodes,
      exempt: options.exemption?.(summary) ?? null,
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
    },
    users,
  }
}

function verdictBadge(verdict: Verdict, score: number): string {
  const text = `${VERDICT_LABELS[verdict]} ${score.toFixed(score >= 99.95 ? 0 : 1)}`
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
  if (archive.messages > 0) lines.push(`时间 ${range(archive.from, archive.to)}`)
  const skipped = Object.entries(archive.skipped)
  if (skipped.length) lines.push(style.gray(`跳过 ${skipped.map(([reason, n]) => `${reason} ${n}`).join(' · ')}`))
  lines.push('')
  lines.push(
    `${style.red(style.bold(`独轮车 ${report.totals.spam} 人`))} · ${style.yellow(`可疑 ${report.totals.suspect} 人`)}`
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
        `#${user.rank} ${verdictBadge(user.verdict, user.score)}  ${style.bold(user.uname || '(无名)')} ${style.gray(`uid ${user.uid} · 房间 ${user.roomId}`)}${user.exempt ? style.cyan(` · 豁免：${user.exempt}`) : ''}`
      )
      lines.push(
        `   ${PATTERN_LABELS[user.pattern]} · 窗口内重复 ${user.repeats} 次 · 自动化 ${user.automation.toFixed(2)} · 共 ${count(user.messages)} 条 · ${user.episodes.length} 段 · 峰值 ${dateTime(user.peakAt)}`
      )
      for (const item of user.evidence) {
        lines.push(
          `   ${style.cyan(`· ${EVIDENCE_LABELS[item.kind]}`)} ${style.gray(item.weight.toFixed(2))} ${item.detail}`
        )
      }
      for (const cluster of user.clusters.slice(0, 2)) {
        lines.push(
          `   「${escapeInvisible(cluster.key).slice(0, 40)}」×${cluster.count} · ${cluster.variants} 种写法 · 中位间隔 ${gap(cluster.medianGapMs)}${cluster.crowd ? ` · 同时 ${cluster.crowd} 人在刷` : ''}`
        )
        for (const sample of cluster.samples.slice(0, options.samples)) {
          lines.push(style.gray(`      ${clock(sample.timestamp)}  ${escapeInvisible(sample.text)}`))
        }
      }
    }
  }
  return lines.join('\n')
}

function gap(ms: number): string {
  return ms > 0 ? `${(ms / 1000).toFixed(1)}s` : '—'
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/** Markdown rendering with every flagged user, for sharing or archiving. */
export function renderMarkdown(report: OfflineReport): string {
  const { archive } = report
  const out: string[] = []
  out.push('# LAPLACE Rinnegan 独轮车检测报告', '')
  out.push(`- 生成时间：${dateTime(Date.parse(report.generatedAt))}（${report.tool}）`)
  out.push(`- 归档：\`${archive.path}\`（${archive.format}）`)
  out.push(
    `- 弹幕：${count(archive.messages)} 条，${count(archive.users)} 名用户，房间 ${archive.rooms.join(', ') || '—'}`
  )
  if (archive.messages > 0) out.push(`- 时间：${range(archive.from, archive.to)}`)
  out.push(`- 结果：独轮车 **${report.totals.spam}** 人，可疑 **${report.totals.suspect}** 人`, '')
  out.push('| # | 判定 | 分数 | 用户 | UID | 模式 | 窗口重复 | 证据 | 主要内容 |')
  out.push('| -: | --- | -: | --- | -: | --- | -: | --- | --- |')
  for (const user of report.users) {
    const top = user.clusters[0]
    out.push(
      `| ${user.rank} | ${VERDICT_LABELS[user.verdict]}${user.exempt ? '（豁免）' : ''} | ${user.score} | ${cell(user.uname)} | ${user.uid} | ${PATTERN_LABELS[user.pattern]} | ${user.repeats} | ${user.evidence.map(item => EVIDENCE_LABELS[item.kind]).join('、')} | ${top ? cell(`「${escapeInvisible(top.key).slice(0, 30)}」×${top.count}`) : ''} |`
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
    for (const item of user.evidence)
      out.push(`- ${EVIDENCE_LABELS[item.kind]}（${item.weight}）：${cell(item.detail)}`)
    for (const episode of user.episodes) {
      out.push(
        `- 时段 ${range(episode.startAt, episode.endAt)}：${VERDICT_LABELS[episode.verdict]}，峰值 ${episode.peakScore}，「${cell(escapeInvisible(episode.key).slice(0, 30))}」`
      )
    }
    for (const cluster of user.clusters) {
      out.push(
        '',
        `「${cell(escapeInvisible(cluster.key))}」×${cluster.count}，${cluster.variants} 种写法，中位间隔 ${gap(cluster.medianGapMs)}，同时 ${cluster.crowd} 人在刷`,
        ''
      )
      for (const sample of cluster.samples)
        out.push(`    ${dateTime(sample.timestamp)}  ${escapeInvisible(sample.text)}`)
    }
  }
  return `${out.join('\n')}\n`
}

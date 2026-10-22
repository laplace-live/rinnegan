import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { RinneganConfig } from '@/config'
import type { ChatMessage } from '@/types'

import { AuditLog } from '@/audit/audit'
import { Detector } from '@/detect/detector'
import { exemptionReason } from '@/enforce/policy'
import { buildReport, renderConsole, renderMarkdown } from '@/report/report'
import { extractMessages, readArchive } from '@/sources/archive'
import { count, log, style } from '@/util/console'
import { VERSION } from '@/version'

export interface OfflineOptions {
  files: string[]
  config: RinneganConfig
  /** Unix ms bounds, inclusive */
  since?: number
  until?: number
  /** Users shown per verdict on the console */
  top: number
  suspects: boolean
  samples: number
  /** Write JSON / Markdown reports into `config.reportDir` */
  writeFiles: boolean
}

function stamp(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Replay archives through the detector and rank 独轮车 users with samples. Returns the exit code. */
export async function runOffline(options: OfflineOptions): Promise<number> {
  const { config } = options
  const audit = new AuditLog({ dir: config.logDir, mode: 'offline' })
  const startedAt = Date.now()
  audit.write('session-start', {
    version: VERSION,
    files: options.files,
    rooms: config.live.rooms,
    since: options.since ?? null,
    until: options.until ?? null,
    detector: config.detector,
  })

  const byId = new Map<string, ChatMessage>()
  const formats: string[] = []
  const skipped: Record<string, number> = {}
  for (const file of options.files) {
    const archive = await readArchive(file)
    formats.push(archive.format)
    const extracted = extractMessages(archive.sheets, {
      rooms: config.live.rooms,
      since: options.since,
      until: options.until,
      includeMirror: config.live.includeMirror,
    })
    for (const message of extracted.messages) byId.set(message.id, message)
    for (const [reason, n] of Object.entries(extracted.skipped)) skipped[reason] = (skipped[reason] ?? 0) + n
  }
  const messages = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))

  const detector = new Detector(config.detector)
  for (const message of messages) detector.ingest(message)
  const summaries = detector.summaries()

  const report = buildReport({
    version: VERSION,
    archive: {
      path: options.files.join(', '),
      format: [...new Set(formats)].join('+'),
      messages: messages.length,
      users: new Set(messages.map(message => message.uid)).size,
      rooms: [...new Set(messages.map(message => message.roomId))].sort((a, b) => a - b),
      from: messages[0]?.timestamp ?? 0,
      to: messages[messages.length - 1]?.timestamp ?? 0,
      skipped,
    },
    detector: detector.options,
    summaries,
    exemption: summary => (summary.peak.verdict === 'spam' ? exemptionReason(summary.peak, config.ban) : null),
  })

  log(renderConsole(report, { top: options.top, suspects: options.suspects, samples: options.samples }))

  for (const user of report.users) {
    audit.write('detection', {
      roomId: user.roomId,
      uid: user.uid,
      uname: user.uname,
      verdict: user.verdict,
      score: user.score,
      pattern: user.pattern,
      repeats: user.repeats,
      peakAt: new Date(user.peakAt).toISOString(),
      exempt: user.exempt,
      evidence: user.evidence,
      samples: user.clusters.flatMap(cluster => cluster.samples.slice(0, 3).map(sample => sample.text)),
    })
  }

  const written: string[] = []
  if (options.writeFiles) {
    mkdirSync(config.reportDir, { recursive: true })
    const name = `${basename(options.files[0] ?? 'archive').replace(/\.(lca|json)$/i, '')}-${stamp(startedAt)}`
    const jsonPath = join(config.reportDir, `${name}.json`)
    const markdownPath = join(config.reportDir, `${name}.md`)
    await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
    await Bun.write(markdownPath, renderMarkdown(report))
    written.push(jsonPath, markdownPath)
  }

  audit.write('session-end', {
    messages: messages.length,
    spam: report.totals.spam,
    suspect: report.totals.suspect,
    reports: written,
    durationMs: Date.now() - startedAt,
  })

  log('')
  log(
    style.gray(
      `${count(messages.length)} 条弹幕，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s · 审计日志 ${audit.path}${written.length ? ` · 报告 ${written.join('、')}` : ''}`
    )
  )
  return 0
}

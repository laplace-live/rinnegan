import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { RinneganConfig } from '@/config'

import { AuditLog } from '@/audit/audit'
import { Detector } from '@/detect/detector'
import { banEligibility } from '@/enforce/policy'
import { buildReport, renderConsole, renderMarkdown } from '@/report/report'
import { extractMessages, readArchive } from '@/sources/archive'
import { count, fileStamp, log, style } from '@/util/console'
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

  const archives = await Promise.all(options.files.map(readArchive))
  const formats = archives.map(archive => archive.format)
  const { messages, skipped } = extractMessages(
    archives.flatMap(archive => archive.sheets),
    { rooms: config.live.rooms, since: options.since, until: options.until, includeMirror: config.live.includeMirror }
  )

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
    // As live mode without AI review would judge the peak
    exemption: summary => banEligibility(summary.peak, config.ban, 'off').exempt,
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
    const name = `${basename(options.files[0] ?? 'archive').replace(/\.(lca|json)$/i, '')}-${fileStamp(startedAt)}`
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

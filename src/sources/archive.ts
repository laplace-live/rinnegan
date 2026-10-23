import type { LaplaceEvent } from '@laplace.live/event-types'

import type { ChatMessage } from '@/types'

import { toChatMessage } from '@/sources/events'

/** On-disk encodings of a LAPLACE Chat Archive (`.lca`); identified by magic bytes only. */
export type ArchiveFormat = 'gzip' | 'zstd' | 'raw'

/** One sheet of an archive, e.g. `main`, `gifts`, `superchats`, `miscs`. */
export interface EventSheet {
  name: string
  data: LaplaceEvent[]
}

export interface Archive {
  format: ArchiveFormat
  sheets: EventSheet[]
}

const GZIP_MAGIC = [0x1f, 0x8b]
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function startsWith(bytes: Uint8Array<ArrayBuffer>, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte)
}

/** Sniff the codec the same way laplace-chat does; null for anything else, such as a pre-2026 lz-string archive. */
export function detectArchiveFormat(bytes: Uint8Array<ArrayBuffer>): ArchiveFormat | null {
  if (startsWith(bytes, ZSTD_MAGIC)) return 'zstd'
  if (startsWith(bytes, GZIP_MAGIC)) return 'gzip'
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart()
  return head.startsWith('[') || head.startsWith('{') ? 'raw' : null
}

/** Decompress archive bytes to its JSON text. */
export function decodeArchiveText(bytes: Uint8Array<ArrayBuffer>): { format: ArchiveFormat; json: string } {
  const format = detectArchiveFormat(bytes)
  const decoder = new TextDecoder()
  switch (format) {
    case 'gzip':
      return { format, json: decoder.decode(Bun.gunzipSync(bytes)) }
    case 'zstd':
      return { format, json: decoder.decode(Bun.zstdDecompressSync(bytes)) }
    case 'raw':
      return { format, json: decoder.decode(bytes) }
    case null:
      throw new Error(
        '无法识别的归档格式：仅支持 gzip、zstd 压缩的 .lca 与 JSON 导出，旧版归档请用新版 LAPLACE Chat 重新导出'
      )
  }
}

/** Parse archive JSON: `EventSheet[]`, or a bare `LaplaceEvent[]` export wrapped as one `main` sheet. */
export function parseArchiveJson(json: string): EventSheet[] {
  const data: unknown = JSON.parse(json)
  if (!Array.isArray(data)) throw new Error('归档内容不是数组')
  const looksLikeSheets = data.every(
    item => typeof item === 'object' && item !== null && 'name' in item && Array.isArray((item as EventSheet).data)
  )
  if (looksLikeSheets) return data as EventSheet[]
  const looksLikeEvents = data.every(item => typeof item === 'object' && item !== null && 'type' in item)
  if (looksLikeEvents) return [{ name: 'main', data: data as LaplaceEvent[] }]
  throw new Error('无法识别的归档结构')
}

/** Read and decode a `.lca` (or raw `.json`) archive from disk. */
export async function readArchive(path: string): Promise<Archive> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`找不到归档文件：${path}`)
  const { format, json } = decodeArchiveText(new Uint8Array(await file.arrayBuffer()))
  return { format, sheets: parseArchiveJson(json) }
}

export interface ExtractOptions {
  rooms?: readonly number[]
  /** Unix ms, inclusive */
  since?: number
  /** Unix ms, inclusive */
  until?: number
  includeMirror?: boolean
}

export interface Extracted {
  messages: ChatMessage[]
  skipped: Record<string, number>
}

/** Oldest first; event id breaks timestamp ties so replays are deterministic. */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  return a.timestamp - b.timestamp || a.id.localeCompare(b.id)
}

/** Every judgeable danmaku across all sheets, deduplicated by event id and sorted oldest first. */
export function extractMessages(sheets: readonly EventSheet[], options: ExtractOptions = {}): Extracted {
  const rooms = options.rooms && options.rooms.length > 0 ? new Set(options.rooms) : null
  const seen = new Set<string>()
  const messages: ChatMessage[] = []
  const skipped: Record<string, number> = {}
  for (const sheet of sheets) {
    for (const event of sheet.data) {
      if (event?.type !== 'message') continue
      if (seen.has(event.id)) continue
      seen.add(event.id)
      const message = toChatMessage(event, { includeMirror: options.includeMirror })
      if (typeof message === 'string') {
        skipped[message] = (skipped[message] ?? 0) + 1
        continue
      }
      if (rooms && !rooms.has(message.roomId)) continue
      if (options.since !== undefined && message.timestamp < options.since) continue
      if (options.until !== undefined && message.timestamp > options.until) continue
      messages.push(message)
    }
  }
  messages.sort(compareMessages)
  return { messages, skipped }
}

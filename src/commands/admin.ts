import type { BilibiliClient } from '@/bilibili'
import type { RinneganConfig } from '@/config'
import type { FetchLike } from '@/util/fetch'

import { AuditLog, listAuditFiles, readAuditEntries } from '@/audit/audit'
import { describeResult } from '@/bilibili'
import { connectLoginSync, openStore } from '@/commands/session'
import { API_GAP_MS, liftSilentUser } from '@/enforce/enforcer'
import { describeStoreUrl } from '@/store'
import { count, dateTime, fail, log, style, warn } from '@/util/console'
import { errorMessage } from '@/util/guards'

/** A logged-in client from the login-sync token, or null after printing why not. */
async function loggedInClient(
  config: RinneganConfig,
  fetch?: FetchLike,
  audit?: AuditLog
): Promise<BilibiliClient | null> {
  if (!config.loginSync.token) {
    fail('需要 LOGIN_SYNC_TOKEN（或 --login-sync-token）才能访问禁言接口')
    return null
  }
  try {
    const { client, nav } = await connectLoginSync(config, fetch, audit)
    log(style.gray(`登录账号 ${nav.uname}（${nav.uid}）`))
    return client
  } catch (error) {
    fail(`无法使用 Login Sync 凭据：${errorMessage(error)}`)
    return null
  }
}

export interface BansOptions {
  config: RinneganConfig
  room: number
  remote: boolean
  local: boolean
  limit: number
  /** Injected fetch, for tests */
  fetch?: FetchLike
}

/** List a room's Bilibili silent list and Rinnegan's own ban records. */
export async function runBans(options: BansOptions): Promise<number> {
  const { config, room } = options
  let exit = 0
  if (options.remote) {
    const client = await loggedInClient(config, options.fetch)
    if (!client) exit = 1
    else {
      try {
        const users = await client.getAllSilentUsers(room)
        log(style.bold(`房间 ${room} 的禁言列表（Bilibili）· ${count(users.length)} 人`))
        for (const user of users) {
          const extra = [
            user.createdAt ? `禁言于 ${user.createdAt}` : '',
            user.operatorName ? `操作者 ${user.operatorName}` : '',
            user.remainingSec !== null ? `剩余 ${Math.round(user.remainingSec / 3600)} 小时` : '',
          ].filter(Boolean)
          log(`  ${user.uname}（${user.uid}）${extra.length ? style.gray(` · ${extra.join(' · ')}`) : ''}`)
        }
      } catch (error) {
        fail(`读取禁言列表失败：${errorMessage(error)}`)
        exit = 1
      }
    }
  }
  if (options.local) {
    const store = await openStore(config, warn)
    if (store) {
      const records = await store.list({ roomId: room, limit: options.limit })
      log(style.bold(`房间 ${room} 的 Rinnegan 封禁记录（${describeStoreUrl(config.storeUrl)}）· ${records.length} 条`))
      for (const record of records) {
        const status =
          record.status === 'active'
            ? style.red('生效中')
            : style.gray(
                `${record.status === 'expired' ? '已到期' : '已解除'} ${record.liftedAt ? dateTime(record.liftedAt) : ''}`
              )
        const expiry = record.expiresAt ? ` · 到期 ${dateTime(record.expiresAt)}` : ''
        const spend = record.spend > 0 ? ` · 封禁后消费 ¥${record.spend.toFixed(2)}` : ''
        log(
          `  ${record.uname}（${record.uid}）${status} · ${dateTime(record.createdAt)}${expiry}${spend} · ${record.reason}`
        )
        if (record.liftReason) log(style.gray(`      ${record.liftReason}`))
      }
      await store.close()
    }
  }
  return exit
}

export interface UnbanOptions {
  config: RinneganConfig
  room: number | null
  uids: number[]
  /** Revert every real ban made by this audit session */
  session: string | null
  reason: string
  dryRun: boolean
  /** Injected fetch, for tests */
  fetch?: FetchLike
  /** Gap between unban calls, ms */
  gapMs?: number
}

interface Target {
  roomId: number
  uid: number
  uname: string
}

/** Bans a session made, read back from the audit logs. */
async function sessionTargets(logDir: string, session: string): Promise<Target[]> {
  const targets = new Map<string, Target>()
  for (const path of listAuditFiles(logDir)) {
    for (const entry of await readAuditEntries(path)) {
      if (entry.session !== session || entry.event !== 'ban' || entry.dryRun !== false) continue
      const roomId = Number(entry.roomId)
      const uid = Number(entry.uid)
      if (roomId > 0 && uid > 0) targets.set(`${roomId}:${uid}`, { roomId, uid, uname: String(entry.uname ?? '') })
    }
  }
  return [...targets.values()]
}

/** Lift bans by uid, or revert a whole live session from its audit trail. */
export async function runUnban(options: UnbanOptions): Promise<number> {
  const { config } = options
  const targets: Target[] = []
  if (options.session) targets.push(...(await sessionTargets(config.logDir, options.session)))
  if (options.room !== null) for (const uid of options.uids) targets.push({ roomId: options.room, uid, uname: '' })
  if (targets.length === 0) {
    fail(
      options.session ? `审计日志中没有会话 ${options.session} 的真实封禁记录` : '请用 --room 与 --uid 指定要解除的用户'
    )
    return 1
  }

  const audit = new AuditLog({ dir: config.logDir, mode: 'unban' })
  audit.write('session-start', { targets, session: options.session, reason: options.reason, dryRun: options.dryRun })
  if (options.dryRun) {
    for (const target of targets)
      log(`[演练] 将解除 ${target.uname || target.uid}（${target.uid}）在房间 ${target.roomId} 的禁言`)
    audit.write('session-end', { lifted: 0, dryRun: true })
    return 0
  }

  const client = await loggedInClient(config, options.fetch, audit)
  if (!client) return 1
  const store = await openStore(config, warn)
  let lifted = 0
  for (const [index, target] of targets.entries()) {
    if (index > 0) await Bun.sleep(options.gapMs ?? API_GAP_MS)
    const record = store ? await store.findActive(target.roomId, target.uid) : null
    const { ok, result } = await liftSilentUser(client, audit, { ...target, banId: record?.id ?? null }, options.reason)
    if (ok && record && store) {
      await store.update(record.id, {
        status: 'lifted',
        liftedAt: Date.now(),
        liftReason: `手动解除：${options.reason}`,
      })
    }
    if (ok) {
      lifted++
      log(`已解除 ${target.uname || record?.uname || target.uid}（${target.uid}）在房间 ${target.roomId} 的禁言`)
    } else fail(`解除失败 ${target.uid}：${describeResult(result)}`)
  }
  await store?.close()
  audit.write('session-end', { lifted, total: targets.length })
  return lifted === targets.length ? 0 : 1
}

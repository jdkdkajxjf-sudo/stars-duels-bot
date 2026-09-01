/**
 * Stars Duels Bot — entry point.
 *
 * Long-polls AltGram Bot API for updates and dispatches to handlers.
 * Health-check HTTP server on port 3006.
 *
 * Start: cd mini-services/duels-bot && bun install && bun --hot index.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { altgram } from './src/altgram'
import { handleUpdate } from './src/handlers'
import type { TgUpdate, TgUser } from './src/types'

const PORT = Number(process.env.PORT) || 3006
const POLL_TIMEOUT = 30
const RETRY_MS = 2000
const OFFSET_FILE = `${import.meta.dir}/.offset.json`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* Offset persistence */
function readPersistedOffset(): number {
  try {
    if (!existsSync(OFFSET_FILE)) return 0
    const raw = JSON.parse(readFileSync(OFFSET_FILE, 'utf8')) as { offset?: unknown }
    if (typeof raw.offset === 'number' && raw.offset > 0) return raw.offset
  } catch (e) {
    console.warn('[offset] read failed:', e)
  }
  return 0
}

function persistOffset(offset: number): void {
  try {
    writeFileSync(OFFSET_FILE, JSON.stringify({ offset }))
  } catch {
    /* non-fatal */
  }
}

/* Health-check server */
const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/' || path === '/health') {
      return new Response('OK: duels-bot running\n', {
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    return new Response('Not Found', { status: 404 })
  },
})
console.log(`[duels-bot] health-check server listening on port ${server.port}`)

/* Hot-reload guard */
const g = globalThis as { __duelsEpoch?: number; __duelsShuttingDown?: boolean }
const epoch = (g.__duelsEpoch ?? 0) + 1
g.__duelsEpoch = epoch
const alive = () => g.__duelsEpoch === epoch && !g.__duelsShuttingDown

/* Main: getMe → deleteWebhook → setMyCommands → poll loop */
async function main() {
  if (!process.env.BOT_TOKEN) {
    console.error('[duels-bot] FATAL: BOT_TOKEN is not set (check .env)')
    process.exit(1)
  }

  // 1. Authorize
  let me: TgUser | null = null
  while (alive()) {
    const res = await altgram.getMe()
    if (res.ok && res.result) {
      me = res.result
      break
    }
    console.error('[duels-bot] getMe failed, retrying in 2s…')
    await sleep(RETRY_MS)
  }
  if (!me) return
  console.log(`[duels-bot] authorized as @${me.username} (id=${me.id})`)

  // 2. deleteWebhook
  const dw = await altgram.deleteWebhook?.() ?? { ok: false }
  console.log(`[duels-bot] deleteWebhook ok=${dw.ok}`)

  // 3. setMyCommands
  const cmds = await altgram.setMyCommands([
    { command: 'start', description: 'Запустить бота' },
    { command: 'help', description: 'Помощь' },
    { command: 'balance', description: 'Баланс звёзд' },
    { command: 'topup', description: 'Пополнить: /topup 100' },
    { command: 'withdraw', description: 'Вывести: /withdraw 50' },
    { command: 'duel', description: 'Дуэль: /duel 100 или /duel @user 100' },
    { command: 'cancel', description: 'Отменить дуэль' },
    { command: 'daily', description: 'Ежедневный бонус' },
    { command: 'ref', description: 'Реферальная ссылка' },
    { command: 'promo', description: 'Активировать промокод' },
    { command: 'stats', description: 'Ваша статистика' },
    { command: 'top', description: 'Лидерборд' },
    { command: 'history', description: 'Последние дуэли' },
  ])
  console.log(`[duels-bot] setMyCommands ok=${cmds.ok}`)

  console.log(`Bot started as @${me.username}, polling AltGram…`)

  // 4. Long polling loop
  let offset = readPersistedOffset()
  console.log(`[duels-bot] polling from offset=${offset}`)

  let firstOk = false
  let emptyCycles = 0
  let handled = 0
  while (alive()) {
    try {
      const res = await altgram.getUpdates({
        offset,
        timeout: POLL_TIMEOUT,
      })

      if (!res.ok) {
        console.error('[poll] getUpdates failed:', res.error_code, res.description)
        await sleep(RETRY_MS)
        continue
      }

      if (!firstOk) {
        firstOk = true
        console.log('[poll] connected — long polling works')
      }

      const updates: TgUpdate[] = res.result ?? []
      for (const u of updates) {
        offset = u.update_id + 1
        persistOffset(offset)
        handled++
        try {
          await handleUpdate(u)
        } catch (e) {
          console.error('[poll] failed to handle update', u.update_id, e)
        }
      }

      if (updates.length === 0) {
        if (++emptyCycles % 8 === 0) {
          console.log(`[poll] idle… offset=${offset} handled=${handled}`)
        }
      } else {
        console.log(`[poll] processed ${updates.length} update(s), offset=${offset}`)
      }
    } catch (e) {
      console.error('[poll] error:', e)
      await sleep(RETRY_MS)
    }
  }

  console.log('[duels-bot] poll loop stopped (reload or shutdown)')
}

/* ------------------------------------------------------------------ */

/* Graceful shutdown */
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  g.__duelsShuttingDown = true
  g.__duelsEpoch = (g.__duelsEpoch ?? 0) + 1
  console.log(`[duels-bot] received ${signal}, shutting down…`)
  server.stop(true)
  setTimeout(() => process.exit(0), 500).unref?.()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

main().catch((e) => {
  console.error('[duels-bot] fatal:', e)
  process.exit(1)
})

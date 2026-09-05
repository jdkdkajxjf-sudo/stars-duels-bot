/**
 * Stars Duels Bot — entry point with self-healing.
 * If the bot process crashes, it auto-restarts.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { altgram } from './src/altgram'
import { handleUpdate, recoverStuckDuels, normalizeUsernames } from './src/handlers'
import { db } from './src/db'
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
    const raw = JSON.parse(readFileSync(OFFSET_FILE, 'utf8')) as { offset?: string | number }
    const offset = typeof raw.offset === 'string' ? Number(raw.offset) : raw.offset
    if (typeof offset === 'number' && offset > 0) return offset
  } catch {
    return 0
  }
  return 0
}

function persistOffset(offset: number): void {
  try {
    writeFileSync(OFFSET_FILE, JSON.stringify({ offset: String(offset) }))
  } catch { /* ignore */ }
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

/* Main function — runs forever, auto-recovers from errors */
async function main() {
  if (!process.env.BOT_TOKEN) {
    console.error('[duels-bot] FATAL: BOT_TOKEN is not set (check .env)')
    process.exit(1)
  }

  // Authorize
  let me: TgUser | null = null
  for (let i = 0; i < 10; i++) {
    const res = await altgram.getMe()
    if (res.ok && res.result) {
      me = res.result
      break
    }
    console.error(`[duels-bot] getMe failed (attempt ${i + 1}), retrying...`)
    await sleep(RETRY_MS)
  }
  if (!me) {
    console.error('[duels-bot] Could not authorize after 10 attempts')
    return
  }
  console.log(`[duels-bot] authorized as @${me.username} (id=${me.id})`)

  // Delete webhook
  try {
    await altgram.deleteWebhook()
  } catch { /* ignore */ }
  console.log(`[duels-bot] deleteWebhook ok`)

  // Set commands
  await altgram.setMyCommands([
    { command: 'start', description: 'Запустить бота' },
    { command: 'menu', description: 'Меню с кнопками' },
    { command: 'help', description: 'Помощь' },
    { command: 'balance', description: 'Баланс звёзд' },
    { command: 'topup', description: 'Пополнить: /topup 100' },
    { command: 'withdraw', description: 'Вывести: /withdraw 50' },
    { command: 'pay', description: 'Перевести: /pay @user 50' },
    { command: 'donate', description: 'Донат боту: /donate 100' },
    { command: 'sendgift', description: '[админ] Отправить gift: /sendgift @user 1000 5' },
    { command: 'listusers', description: '[админ] Список всех юзеров в БД' },
    { command: 'give', description: '[админ] Начислить звёзды: /give @user 100' },
    { command: 'adminstats', description: '[админ] Статистика бота' },
    { command: 'duel', description: 'Дуэль: /duel 100 или /duel @user 100' },
    { command: 'cancel', description: 'Отменить дуэль' },
    { command: 'daily', description: 'Ежедневный бонус' },
    { command: 'ref', description: 'Реферальная ссылка' },
    { command: 'promo', description: 'Активировать промокод' },
    { command: 'stats', description: 'Ваша статистика' },
    { command: 'top', description: 'Лидерборд' },
    { command: 'history', description: 'Последние дуэли' },
  ])
  console.log(`[duels-bot] setMyCommands ok`)

  console.log(`Bot started as @${me.username}, polling AltGram…`)

  // ПРОВЕРКА БД: логируем тип подключения
  try {
    const userCount = await db.user.count()
    console.log(`[db] Подключено. Юзеров в БД: ${userCount}`)
  } catch (e) {
    console.error(`[db] ОШИБКА подключения к БД:`, e)
    console.error(`[db] DATABASE_URL = ${process.env.DATABASE_URL?.slice(0, 50)}...`)
    throw e
  }

  // ЗАЩИТА ОТ СБОЕВ: вернуть ставки из незавершённых дуэлей
  await recoverStuckDuels()

  // МИГРАЦИЯ: привести username к lowercase (SQLite не поддерживает mode: insensitive)
  await normalizeUsernames()

  // Long polling loop — с автоматическим восстановлением
  let offsetStr = String(readPersistedOffset())
  console.log(`[duels-bot] polling from offset=${offsetStr}`)

  let handled = 0
  let consecutiveErrors = 0

  // Бесконечный цикл с авто-восстановлением
  while (true) {
    try {
      const apiUrl = `${process.env.ALTGRAM_API_URL || 'http://188.134.95.254:2610'}/bot${process.env.BOT_TOKEN}/getUpdates`
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"offset":${offsetStr},"timeout":${POLL_TIMEOUT},"allowed_updates":["message","callback_query","edited_message","pre_checkout_query"]}`,
      })

      if (!res.ok) {
        console.error(`[poll] HTTP ${res.status}, retrying...`)
        consecutiveErrors++
        await sleep(RETRY_MS)
        continue
      }

      const data = await res.json() as { ok: boolean; result?: TgUpdate[]; error_code?: number; description?: string }

      if (!data.ok) {
        const errorCode = data.error_code || 0
        if (errorCode === 409) {
          // 409 Conflict — другой процесс тоже поллит. Ждём 60 сек.
          console.log('[poll] 409 Conflict — another instance running. Waiting 60s...')
          await sleep(60_000)
        } else {
          console.error('[poll] getUpdates failed:', data.error_code, data.description)
          await sleep(RETRY_MS)
        }
        continue
      }

      consecutiveErrors = 0 // Reset on success

      const updates: TgUpdate[] = data.result ?? []
      for (const u of updates) {
        try {
          offsetStr = String(BigInt(u.update_id) + 1n)
          persistOffset(Number(offsetStr))
          handled++
          await handleUpdate(u)
        } catch (e) {
          console.error('[poll] handler error for update', u.update_id, e)
          // НЕ прерываем цикл — продолжаем обрабатывать следующие апдейты
        }
      }

      if (updates.length > 0) {
        console.log(`[poll] processed ${updates.length} update(s), offset=${offsetStr}, total=${handled}`)
      }
    } catch (e) {
      // ConnectionRefused / ECONNRESET — AltGram сервер недоступен
      const errorMsg = String(e)
      if (errorMsg.includes('ConnectionRefused') || errorMsg.includes('ECONNRESET') || errorMsg.includes('Unable to connect')) {
        console.error('[poll] AltGram server unreachable, waiting 15s...')
        await sleep(15_000)
      } else {
        console.error('[poll] unexpected error:', e)
        await sleep(RETRY_MS * 2)
      }
    }
  }
}

// Graceful shutdown
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[duels-bot] received ${signal}, shutting down…`)
  server.stop(true)
  setTimeout(() => process.exit(0), 500).unref?.()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
// Игнорируем SIGPIPE (может приходить от sandbox)
process.on('SIGPIPE', () => {})

// Запуск с авто-рестартом
main().catch(async (e) => {
  console.error('[duels-bot] fatal error:', e)
  // Пробуем перезапуститься через 10 сек
  console.log('[duels-bot] restarting in 10 seconds...')
  await new Promise((r) => setTimeout(r, 10_000))
  // Перезапускаем main
  main().catch((e2) => {
    console.error('[duels-bot] second fatal, giving up:', e2)
    process.exit(1)
  })
})

// Ловим unhandled rejections — чтобы бот не падал
process.on('unhandledRejection', (reason) => {
  console.error('[duels-bot] unhandledRejection:', reason)
})

// Ловим uncaught exceptions — чтобы бот не падал
process.on('uncaughtException', (err) => {
  console.error('[duels-bot] uncaughtException:', err)
})

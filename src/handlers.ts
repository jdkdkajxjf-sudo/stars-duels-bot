/**
 * Stars Duels Bot — command & button handlers.
 *
 * Uses ReplyKeyboardMarkup for main menu (persistent bottom keyboard)
 * and InlineKeyboardMarkup for contextual actions (accept/pay/withdraw).
 */

import { db } from './db'
import { altgram, md, type TgInlineKeyboardMarkup, type TgEntity } from './altgram'
import type { TgCallbackQuery, TgMessage, TgUpdate, TgUser } from './types'

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'crash').toLowerCase()
const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || '0.10')
const MIN_BET = 15  // Минимальная ставка — 15⭐
const MAX_BET = 5000

/**
 * ЗАЩИТА ОТ СБОЕВ — вызывается при старте бота.
 * Возвращает ставки всем, кто оплатил дуэль но она не завершилась.
 * Отменяет все незавершённые дуэли.
 */
export async function recoverStuckDuels() {
  try {
    // Найти все дуэли в статусе accepted/paid/rolling (оплачены но не завершены)
    const stuck = await db.duel.findMany({
      where: { status: { in: ['accepted', 'paid', 'rolling'] } },
    })

    if (stuck.length === 0) {
      console.log('[recovery] No stuck duels found')
      return
    }

    console.log(`[recovery] Found ${stuck.length} stuck duels, refunding...`)

    for (const duel of stuck) {
      // Возврат оплатившему player1
      if (duel.paid1At) {
        const u1 = await db.user.findUnique({ where: { tgId: duel.player1TgId } })
        if (u1) {
          await creditBalance(u1.id, duel.amount, 'refund', `Возврат при сбое — дуэль ${duel.id.slice(-8)}`, duel.id)
          try {
            await send(u1.tgId, `⚠️ **Сервер был перезапущен.**\nДуэль отменена.\n💰 Возврат ${duel.amount}⭐.\nБаланс: ${(await db.user.findUnique({ where: { id: u1.id } }))?.balance ?? 0}⭐`)
          } catch { /* ignore */ }
        }
      }

      // Возврат оплатившему player2
      if (duel.paid2At && duel.player2TgId) {
        const u2 = await db.user.findUnique({ where: { tgId: duel.player2TgId } })
        if (u2) {
          await creditBalance(u2.id, duel.amount, 'refund', `Возврат при сбое — дуэль ${duel.id.slice(-8)}`, duel.id)
          try {
            await send(u2.tgId, `⚠️ **Сервер был перезапущен.**\nДуэль отменена.\n💰 Возврат ${duel.amount}⭐.\nБаланс: ${(await db.user.findUnique({ where: { id: u2.id } }))?.balance ?? 0}⭐`)
          } catch { /* ignore */ }
        }
      }

      // Отменить дуэль
      await db.duel.update({
        where: { id: duel.id },
        data: { status: 'cancelled' },
      })
    }

    // Также отменяем waiting дуэли (никто не принял)
    const waiting = await db.duel.updateMany({
      where: { status: 'waiting' },
      data: { status: 'timed_out' },
    })

    console.log(`[recovery] Refunded ${stuck.length} duels, cancelled ${waiting.count} waiting duels`)
  } catch (e) {
    console.error('[recovery] Error:', e)
  }
}

/**
 * МИГРАЦИЯ — приводим все username к lowercase.
 * Вызывается один раз при старте бота.
 */
export async function normalizeUsernames() {
  try {
    const users = await db.user.findMany({
      where: { username: { not: null } },
      select: { id: true, username: true },
    })
    let fixed = 0
    for (const u of users) {
      if (u.username && u.username !== u.username.toLowerCase()) {
        await db.user.update({
          where: { id: u.id },
          data: { username: u.username.toLowerCase() },
        })
        fixed++
      }
    }
    console.log(`[migration] Normalized ${fixed} usernames to lowercase (total: ${users.length})`)
  } catch (e) {
    console.error('[migration] Error normalizing usernames:', e)
  }
}
const NEW_USER_MAX_BET = 100
const NEW_USER_HOURS = 24
const DUEL_COOLDOWN_MS = 30_000
const MAX_DUELS_PER_HOUR = 10
const ACCEPT_TIMEOUT_MS = 3 * 60_000
const PAY_TIMEOUT_MS = 5 * 60_000
const FAST_CLICK_TIMEOUT_MS = 60_000

const DICE_EMOJI = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅']
const DICE_FACE = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣']

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* Reply keyboard (main menu) — only shown in private chat             */
/* ------------------------------------------------------------------ */

type ReplyKeyboardMarkup = {
  keyboard: { text: string }[][]
  resize_keyboard: boolean
  one_time_keyboard?: boolean
  selective?: boolean
}

function mainMenuKeyboard(isAdmin: boolean): ReplyKeyboardMarkup {
  const rows: { text: string }[][] = [
    [{ text: '🎲 Дуэль' }, { text: '💰 Баланс' }],
    [{ text: '🎁 Бонусы' }, { text: '📊 Статистика' }],
    [{ text: '🏆 Топ' }, { text: '📜 История' }],
  ]
  if (isAdmin) {
    rows.push([{ text: '⚡ Админ' }])
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
  }
}

async function sendMainMenu(
  msg: TgMessage,
  text: string,
  user: { isAdmin: boolean }
) {
  // Reply keyboard only in private chats — in groups we use inline buttons only
  if (msg.chat.type !== 'private') {
    return send(msg.chat.id, text)
  }
  const { text: plain, entities } = md(text)
  return altgram.sendMessage({
    chat_id: msg.chat.id,
    text: plain,
    entities,
    reply_markup: mainMenuKeyboard(user.isAdmin) as unknown as TgInlineKeyboardMarkup,
  })
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function isPrivate(msg: TgMessage): boolean {
  return msg.chat.type === 'private'
}

function isAdminUser(user: TgUser): boolean {
  return user.username?.toLowerCase() === ADMIN_USERNAME
}

function parseAmount(s: string | undefined): number | null {
  if (!s) return null
  const n = Number(s.replace(/[⭐*,]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
}

function mention(user: { username?: string | null; firstName?: string | null; tgId: string }): string {
  if (user.username) return `@${user.username}`
  if (user.firstName && !user.firstName.startsWith('+') && user.firstName !== '⠀') return user.firstName
  return `Игрок ${user.tgId.slice(-4)}`
}

function mentionByTg(tgId: string, username?: string | null, firstName?: string | null): string {
  if (username) return `@${username}`
  if (firstName && !firstName.startsWith('+') && firstName !== '⠀') return firstName
  return `Игрок ${tgId.slice(-4)}`
}

async function send(
  chatId: number | string,
  text: string,
  replyMarkup?: TgInlineKeyboardMarkup,
  replyTo?: number
) {
  const { text: plain, entities } = md(text)
  return altgram.sendMessage({
    chat_id: chatId,
    text: plain,
    entities,
    reply_markup: replyMarkup,
    reply_to_message_id: replyTo,
  })
}

async function upsertUser(from: TgUser) {
  const isAdminFlag = from.username?.toLowerCase() === ADMIN_USERNAME
  const existing = await db.user.findUnique({ where: { tgId: String(from.id) } })
  if (!existing) {
    // NEW USER — give 10⭐ starting bonus (Feature #6)
    const user = await db.user.create({
      data: {
        tgId: String(from.id),
        username: from.username?.toLowerCase() ?? null,
        firstName: from.first_name ?? null,
        lastName: from.last_name ?? null,
        isAdmin: isAdminFlag,
        balance: 10, // Starting bonus
      },
    })
    await db.transaction.create({
      data: {
        userId: user.id,
        type: 'welcome_bonus',
        amount: 10,
        balanceAfter: 10,
        note: 'Стартовый бонус за регистрацию',
      },
    })
    return user
  }
  return db.user.update({
    where: { tgId: String(from.id) },
    data: {
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      ...(isAdminFlag ? { isAdmin: true } : {}),
    },
  })
}

async function ensureReferralCode(userId: string): Promise<string> {
  const u = await db.user.findUnique({ where: { id: userId } })
  if (u?.referralCode) return u.referralCode
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = ''
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
    try {
      const updated = await db.user.update({
        where: { id: userId },
        data: { referralCode: code },
      })
      return updated.referralCode!
    } catch {
      /* collision */
    }
  }
  const updated = await db.user.update({
    where: { id: userId },
    data: { referralCode: `SD${userId.slice(-4).toUpperCase()}` },
  })
  return updated.referralCode!
}

async function creditBalance(
  userId: string,
  amount: number,
  type: string,
  note?: string,
  duelId?: string
) {
  return db.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: userId },
      data: { balance: { increment: amount } },
    })
    await tx.transaction.create({
      data: { userId, type, amount, balanceAfter: u.balance, note: note ?? null, duelId: duelId ?? null },
    })
    return u
  })
}

async function debitBalance(
  userId: string,
  amount: number,
  type: string,
  note?: string,
  duelId?: string
) {
  return db.$transaction(async (tx) => {
    const fresh = await tx.user.findUnique({ where: { id: userId } })
    if (!fresh) throw new Error('user_missing')
    if (fresh.balance < amount) throw new Error('insufficient_balance')
    const u = await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: amount } },
    })
    await tx.transaction.create({
      data: { userId, type, amount: -amount, balanceAfter: u.balance, note: note ?? null, duelId: duelId ?? null },
    })
    return u
  })
}

/* ------------------------------------------------------------------ */
/* Update dispatch                                                     */
/* ------------------------------------------------------------------ */

export async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    // Handle pre_checkout_query — AltGram присылает перед оплатой Stars.
    // Раньше мы его игнорировали → AltGram спамил им снова и снова.
    // Теперь отвечаем ok:true — это подтверждает платёж и останавливает спам.
    // Если ok:false — отменит платёж (нужно если не хотим принимать).
    if (update.pre_checkout_query) {
      const pcq = update.pre_checkout_query
      const userId = pcq.from?.id
      const chatId = pcq.from?.id  // отвечаем в личку юзеру
      console.log(`[pre_checkout] id=${pcq.id} user=${userId} — answering ok:true`)

      try {
        const res = await altgram.answerPreCheckoutQuery({
          pre_checkout_query_id: String(pcq.id),
          ok: true,
        })
        console.log(`[pre_checkout] answer result:`, JSON.stringify(res).slice(0, 200))

        // Уведомить пользователя что платёж обрабатывается
        if (chatId) {
          try {
            await altgram.sendMessage({
              chat_id: chatId,
              text: `⏳ Платёж обрабатывается… Звёзды будут зачислены автоматически после подтверждения.`,
            })
          } catch { /* ignore */ }
        }
      } catch (e) {
        console.error(`[pre_checkout] answer failed:`, e)
      }
      return
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query)
      return
    }

    const msg = update.message ?? update.edited_message
    if (!msg) return

    if (msg.successful_payment) {
      await handleSuccessfulPayment(msg)
      return
    }

    if (update.edited_message) return

    if (msg.text) {
      await handleTextMessage(msg)
    }
  } catch (e) {
    console.error('[handler] error processing update:', update.update_id, e)
    // ВАЖНО: сообщаем пользователю что команда упала — иначе бот молчит и юзер не понимает
    try {
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id
      if (chatId) {
        const errMsg = e instanceof Error ? e.message : String(e)
        await altgram.sendMessage({
          chat_id: chatId,
          text: `❌ Внутренняя ошибка команды.\n\nДетали: ${errMsg.slice(0, 300)}`,
        })
      }
    } catch { /* ignore — не можем даже отправить */ }
  }
}

async function handleTextMessage(msg: TgMessage) {
  const from = msg.from
  if (!from || from.is_bot) return

  const user = await upsertUser(from)

  if (user.isBanned) {
    await send(msg.chat.id, '🚫 Вы заблокированы.')
    return
  }

  const raw = (msg.text ?? '').trim()
  const parts = raw.split(/\s+/)
  const head = parts[0] ?? ''
  const cmd = (head.split('@')[0] ?? '').toLowerCase()

  // Handle /start with referral
  if (cmd === '/start') {
    const arg = parts[1]
    if (arg && arg.startsWith('ref_')) {
      await handleStartWithRef(msg, user, arg)
      return
    }
    await sendWelcome(msg, user)
    return
  }

  // Handle reply keyboard button taps (in private chat)
  if (isPrivate(msg)) {
    switch (raw) {
      case '🎲 Дуэль':
        await sendDuelHelp(msg.chat.id)
        return
      case '💰 Баланс':
        await sendBalanceWithButtons(msg.chat.id, user)
        return
      case '🎁 Бонусы':
        await sendBonusesMenu(msg.chat.id)
        return
      case '📊 Статистика':
        await handleStats(msg, user)
        return
      case '🏆 Топ':
        await handleTop(msg, 'week')
        return
      case '📜 История':
        await handleHistory(msg, user, undefined)
        return
      case '⚡ Админ':
        if (user.isAdmin) {
          await sendAdminMenu(msg.chat.id)
        }
        return
    }
  }

  // Commands
  switch (cmd) {
    case '/help':
      await sendHelp(msg, user)
      break
    case '/menu':
      await sendInlineMenu(msg.chat.id, user)
      break
    case '/balance':
    case '/bal':
      await sendBalanceWithButtons(msg.chat.id, user)
      break
    case '/topup':
      await handleTopup(msg, user, parts[1])
      break
    case '/withdraw':
      await handleWithdraw(msg, user, parts[1])
      break
    case '/cashout':
      await sendCashoutMenu(msg.chat.id)
      break
    case '/duel':
      await handleDuelCommand(msg, user, parts.slice(1))
      break
    case '/cancel':
      await handleCancel(msg, user)
      break
    case '/daily':
      await handleDaily(msg, user)
      break
    case '/ref':
      await handleRef(msg, user)
      break
    case '/promo':
      await handlePromo(msg, user, parts.slice(1).join(' '))
      break
    case '/pay':
    case '/transfer':
      await handlePay(msg, user, parts[1], parts[2])
      break
    case '/stats':
      await handleStats(msg, user)
      break
    case '/top':
      await handleTop(msg, parts[1] || 'week')
      break
    case '/history':
      await handleHistory(msg, user, parts[1])
      break
    case '/addfc':
      await handleAddFastClick(msg, user, parts[1])
      break
    case '/addpromo':
      await handleAddPromo(msg, user, parts[1])
      break
    case '/donate':
      await handleDonate(msg, user, parts[1])
      break
    case '/sendgift':
      await handleSendGift(msg, user, parts.slice(1))
      break
    case '/adminstats':
      await handleAdminStats(msg, user)
      break
    case '/ban':
      await handleBan(msg, user, parts[1])
      break
    case '/give':
      await handleGive(msg, user, parts[1], parts[2])
      break
    case '/broadcast':
      await handleBroadcast(msg, user, parts.slice(1).join(' '))
      break
    case '/listusers':
      await handleListUsers(msg, user)
      break
    default:
      if (cmd.startsWith('/')) {
        await send(msg.chat.id, '🤔 Неизвестная команда. /help — список команд.')
      }
  }
}

/* ------------------------------------------------------------------ */
/* /listusers — админ: показать всех юзеров в БД (для диагностики)     */
/* ------------------------------------------------------------------ */

async function handleListUsers(
  msg: TgMessage,
  user: { isAdmin: boolean }
) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  const users = await db.user.findMany({
    select: { username: true, tgId: true, firstName: true, balance: true, isAdmin: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const lines = users.map(u => {
    const name = u.username ? `@${u.username}` : (u.firstName || '(no name)')
    const adminTag = u.isAdmin ? ' 👑admin' : ''
    return `• ${name} — tgId: ${u.tgId} — ${u.balance}⭐${adminTag}`
  })
  await send(
    msg.chat.id,
    `📋 **Юзеры в БД (${users.length}):**\n\n${lines.join('\n')}\n\nИспользуйте:\n` +
    `\`/sendgift <username> <amount> <count>\` — для отправки gift`
  )
}

/* ------------------------------------------------------------------ */
/* Welcome + main menu                                                */
/* ------------------------------------------------------------------ */

async function handleStartWithRef(msg: TgMessage, user: { id: string; tgId: string; username: string | null; firstName: string | null; balance: number; isAdmin: boolean; referredById: string | null }, refArg: string) {
  const code = refArg.slice(4)
  const referrer = await db.user.findUnique({ where: { referralCode: code } })
  if (referrer && !user.referredById && referrer.tgId !== user.tgId) {
    await db.user.update({ where: { id: user.id }, data: { referredById: referrer.id } })
    await creditBalance(referrer.id, 5, 'referral', `Реферал ${user.username || user.firstName} зарегистрировался`)
    try {
      const refBal = (await db.user.findUnique({ where: { id: referrer.id } }))?.balance ?? 0
      await send(referrer.tgId, `🎁 Новый реферал! **${user.username ? '@' + user.username : user.firstName || 'Игрок'}** зарегистрировался.\n+5⭐ на баланс.\nБаланс: ${refBal}⭐`)
    } catch { /* ignore */ }
  }
  await sendWelcome(msg, user)
}

async function sendWelcome(msg: TgMessage, user: { id: string; balance: number; isAdmin: boolean; createdAt?: Date }) {
  const isPrivate = msg.chat.type === 'private'
  // Check if user is truly new (created within last 5 minutes)
  const isNewUser = user.createdAt ? Date.now() - user.createdAt.getTime() < 5 * 60 * 1000 : false
  const text = [
    '🎲 **Stars Duels Bot**',
    '',
    'Сражайся в дуэлях на кубиках за Telegram Stars ⭐!',
    'Бросаем 3 кубика — у кого больше сумма, тот победил.',
    `Комиссия с выигрыша: ${Math.round(COMMISSION_RATE * 100)}%.`,
    '',
    isNewUser ? '🎁 **Стартовый бонус: +10⭐ за регистрацию!**' : '',
    `💰 Твой баланс: **${user.balance}⭐**`,
    '',
    isPrivate ? 'Используй кнопки внизу 👇' : 'В группе: `/duel 100` — создать дуэль',
  ].filter(Boolean).join('\n')

  if (isPrivate) {
    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '💳 Пополнить', callback_data: 'topup' },
          { text: '💸 Вывести', callback_data: 'cashout' },
        ],
        [
          { text: '🎁 Daily', callback_data: 'daily' },
          { text: '🔗 Рефералка', callback_data: 'ref' },
          { text: '📊 Стата', callback_data: 'stats' },
        ],
        [
          { text: '🏆 Топ', callback_data: 'top' },
          { text: '📜 История', callback_data: 'history' },
          { text: '📋 Меню', callback_data: 'menu' },
        ],
      ],
    }
    const { text: plain, entities } = md(text)
    await altgram.sendMessage({
      chat_id: msg.chat.id,
      text: plain,
      entities,
      reply_markup: mainMenuKeyboard(user.isAdmin) as unknown as TgInlineKeyboardMarkup,
    })
    await send(msg.chat.id, '⚡ **Быстрые действия:**', kb)
  } else {
    await send(msg.chat.id, text)
  }
}

async function sendInlineMenu(chatId: number | string, user: { id: string; balance: number; isAdmin: boolean }) {
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '💳 Пополнить', callback_data: 'topup' },
        { text: '💸 Вывести', callback_data: 'cashout' },
      ],
      [
        { text: '🎁 Daily', callback_data: 'daily' },
        { text: '🔗 Рефералка', callback_data: 'ref' },
      ],
      [
        { text: '📊 Статистика', callback_data: 'stats' },
        { text: '🏆 Топ', callback_data: 'top' },
        { text: '📜 История', callback_data: 'history' },
      ],
      ...(user.isAdmin ? [
        [
          { text: '⚡ Fast Click', callback_data: 'admin_fc' },
          { text: '🎁 Промокод', callback_data: 'admin_promo' },
        ],
        [
          { text: '📊 Стата бота', callback_data: 'admin_stats' },
        ],
      ] : []),
    ],
  }
  await send(chatId, `📋 **Меню**\n💰 Баланс: ${user.balance}⭐\n\nВыбери действие:`, kb)
}

async function sendDuelHelp(chatId: number | string) {
  await send(
    chatId,
    [
      '🎲 **Дуэли**',
      '',
      'Дуэли работают в группах!',
      '',
      '**В группе:**',
      '`/duel 100` — публичная дуэль',
      '`/duel @user 100` — вызвать конкретного юзера',
      '`/cancel` — отменить дуэль',
      '',
      `Лимит: ${MIN_BET}-${MAX_BET}⭐`,
      `Комиссия с выигрыша: ${Math.round(COMMISSION_RATE * 100)}%`,
    ].join('\n')
  )
}

async function sendBalanceWithButtons(
  chatId: number | string,
  user: { balance: number }
) {
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '💳 Пополнить', callback_data: 'topup' },
        { text: '💸 Вывести', callback_data: 'cashout' },
      ],
    ],
  }
  await send(
    chatId,
    `💰 **Твой баланс: ${user.balance}⭐**\n\nВыбери действие:`,
    kb
  )
}

async function sendBonusesMenu(chatId: number | string) {
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '📅 Ежедневный', callback_data: 'daily' },
        { text: '🔗 Рефералка', callback_data: 'ref' },
      ],
      [{ text: '🎟️ Активировать промокод', callback_data: 'promo_input' }],
    ],
  }
  await send(
    chatId,
    '🎁 **Бонусы**\n\nВыбери действие:',
    kb
  )
}

async function sendAdminMenu(chatId: number | string) {
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '⚡ Fast Click', callback_data: 'admin_fc' },
        { text: '🎁 Промокод', callback_data: 'admin_promo' },
      ],
      [
        { text: '📊 Статистика', callback_data: 'admin_stats' },
        { text: '📢 Рассылка', callback_data: 'admin_broadcast' },
      ],
    ],
  }
  await send(
    chatId,
    '⚡ **Админ-панель**\n\nВыбери действие:',
    kb
  )
}

/* ------------------------------------------------------------------ */
/* /help                                                               */
/* ------------------------------------------------------------------ */

async function sendHelp(msg: TgMessage, user: { isAdmin: boolean }) {
  const text = [
    '🆘 **Помощь по Stars Duels**',
    '',
    '🎲 **Дуэли (в группах):**',
    '`/duel 100` — публичная дуэль',
    '`/duel @user 100` — вызвать юзера',
    '`/cancel` — отменить дуэль',
    '',
    '💰 **Баланс:**',
    '`/balance` — баланс + кнопки пополнить/вывести',
    '`/topup 100` — пополнить через Stars',
    '`/withdraw 50` — вывести (50 или 100⭐)',
    '`/pay @user 50` — перевести звёзды другу',
    '`/donate 100` — поддержать бота донатом',
    '',
    '🎁 **Бонусы:**',
    '`/daily` — ежедневный бонус',
    '`/ref` — реферальная ссылка',
    '`/promo КОД` — активировать промокод',
    '',
    '📊 **Статистика:**',
    '`/stats` — ваша статистика',
    '`/top` — лидерборд',
    '`/history` — последние дуэли',
    '',
    `💡 Комиссия: ${Math.round(COMMISSION_RATE * 100)}% с выигрыша`,
    `💡 Лимит ставок: ${MIN_BET}-${MAX_BET}⭐`,
  ].join('\n')

  if (msg.chat.type === 'private') {
    const { text: plain, entities } = md(text)
    await altgram.sendMessage({
      chat_id: msg.chat.id,
      text: plain,
      entities,
      reply_markup: mainMenuKeyboard(user.isAdmin) as unknown as TgInlineKeyboardMarkup,
    })
  } else {
    await send(msg.chat.id, text)
  }
}

/* ------------------------------------------------------------------ */
/* /topup                                                              */
/* ------------------------------------------------------------------ */

async function handleTopup(
  msg: TgMessage,
  user: { id: string; tgId: string; balance: number },
  amountArg?: string
) {
  if (!isPrivate(msg)) {
    await send(msg.chat.id, '🔒 Пополнить можно только в личке с ботом. Напиши мне в ЛС.')
    return
  }
  const amount = parseAmount(amountArg)
  if (!amount || amount < 1 || amount > 10000) {
    // Show quick-select buttons
    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '50⭐', callback_data: 'topup:50' },
          { text: '100⭐', callback_data: 'topup:100' },
          { text: '250⭐', callback_data: 'topup:250' },
        ],
        [
          { text: '500⭐', callback_data: 'topup:500' },
          { text: '1000⭐', callback_data: 'topup:1000' },
        ],
      ],
    }
    await send(msg.chat.id, '💳 **Пополнение баланса**\n\nВыберите сумму:', kb)
    return
  }

  await sendInvoice(user, amount)
}

async function sendInvoice(user: { id: string; tgId: string }, amount: number) {
  const res = await altgram.sendInvoice({
    chat_id: Number(user.tgId),
    title: `Пополнение ${amount}⭐`,
    description: `Баланс Stars Duels +${amount}⭐. ID: ${user.id.slice(-8)}`,
    payload: `topup:${user.id}:${amount}`,
    currency: 'XTR',
    prices: [{ label: `${amount} Stars`, amount }],
  })
  if (!res.ok) {
    await send(user.tgId, '⚠️ Не удалось создать инвойс. Попробуйте позже.')
  }
}

async function handleSuccessfulPayment(msg: TgMessage) {
  const sp = msg.successful_payment
  if (!sp) return
  const payload = sp.invoice_payload
  if (!payload) return

  // topup:user_id:amount  OR  duel:duelId:tgId
  if (payload.startsWith('topup:')) {
    const [, userId, amountStr] = payload.split(':')
    const amount = Number(amountStr)
    if (!userId || !Number.isFinite(amount) || amount <= 0) return

    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) return

    const existing = await db.transaction.findFirst({
      where: {
        userId,
        type: 'deposit',
        amount,
        note: { contains: sp.telegram_payment_charge_id || 'unknown' },
      },
    })
    if (existing) {
      await send(msg.chat.id, '✅ Этот платёж уже зачислен.')
      return
    }

    await creditBalance(userId, amount, 'deposit', `Пополнение (${sp.telegram_payment_charge_id || 'paid'})`)

    const u = await db.user.findUnique({ where: { id: userId }, include: { referrer: true } })
    if (u?.referrer) {
      // Базовый бонус: 5% от пополнения
      const bonus = Math.floor(amount * 0.05)
      if (bonus > 0) {
        await creditBalance(u.referrer.id, bonus, 'referral', `5% от пополнения реферала`)
      }

      // Feature #15: Реферальный буст — 10 рефералов → +50⭐ + 10% от их игр
      const referralCount = await db.user.count({ where: { referredById: u.referrer.id } })
      if (referralCount === 10) {
        // Достиг 10 рефералов — бонус 50⭐
        const alreadyRewarded = await db.transaction.findFirst({
          where: { userId: u.referrer.id, type: 'referral_milestone', note: { contains: '10' } },
        })
        if (!alreadyRewarded) {
          await creditBalance(u.referrer.id, 50, 'referral_milestone', 'Бонус за 10 рефералов!')
          try {
            await send(u.referrer.tgId, `🎉 **Бонус за 10 рефералов!** +50⭐ на баланс!\nТеперь вы получаете 10% от всех игр рефералов!`)
          } catch { /* ignore */ }
        }
      }

      // Если у реферера 10+ рефералов — 10% от пополнения вместо 5%
      if (referralCount >= 10) {
        const extraBonus = Math.floor(amount * 0.05) // ещё 5% сверху
        if (extraBonus > 0) {
          await creditBalance(u.referrer.id, extraBonus, 'referral_boost', `Доп. 5% (буст за 10+ рефералов)`)
        }
      }
    }

    const newBal = (await db.user.findUnique({ where: { id: userId } }))?.balance ?? 0
    await send(msg.chat.id, `✅ Зачислено **${amount}⭐**!\nТекущий баланс: **${newBal}⭐**`)
    return
  }

  // duel:duelId:tgId — payment for a duel
  if (payload.startsWith('duel:')) {
    const [, duelId, tgId] = payload.split(':')
    if (!duelId || !tgId) return

    // Credit the user's balance first, then mark as paid
    const u = await db.user.findUnique({ where: { tgId } })
    if (!u) return

    const duel = await db.duel.findUnique({ where: { id: duelId } })
    if (!duel || duel.amount <= 0) return

    // Idempotency: check if already paid
    const existing = await db.transaction.findFirst({
      where: {
        userId: u.id,
        type: 'duel_bet',
        duelId,
        note: { contains: sp.telegram_payment_charge_id || 'unknown' },
      },
    })
    if (existing) return

    await creditBalance(u.id, duel.amount, 'deposit', `Оплата дуэли через Stars (${sp.telegram_payment_charge_id || 'paid'})`, duelId)
    await debitBalance(u.id, duel.amount, 'duel_bet', `Ставка за дуэль ${duelId.slice(-8)}`, duelId)

    await send(u.tgId, `✅ Оплата принята. Ожидаем второго игрока...`)
    await markPaid(duelId, tgId)
  }
}

/* ------------------------------------------------------------------ */
/* /withdraw + /cashout                                               */
/* ------------------------------------------------------------------ */

async function sendCashoutMenu(chatId: number | string) {
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '💸 50⭐', callback_data: 'withdraw:50' },
        { text: '💸 100⭐', callback_data: 'withdraw:100' },
      ],
      [
        { text: '💸 500⭐', callback_data: 'withdraw:500' },
        { text: '💸 1000⭐', callback_data: 'withdraw:1000' },
      ],
    ],
  }
  await send(
    chatId,
    '💸 **Вывод звёзд через Telegram Gift**\n\nПодарок придёт сразу!\nДоступные суммы: 50, 100, 500, 1000⭐.',
    kb
  )
}

async function handleWithdraw(
  msg: TgMessage,
  user: { id: string; tgId: string; balance: number; username: string | null; firstName: string | null },
  amountArg?: string
) {
  if (!isPrivate(msg)) {
    await send(msg.chat.id, '🔒 Вывод только в личке с ботом.')
    return
  }
  const amount = parseAmount(amountArg)
  const validWithdrawAmounts = [50, 100, 500, 1000]
  if (!amount || !validWithdrawAmounts.includes(amount)) {
    await sendCashoutMenu(msg.chat.id)
    return
  }
  await processWithdrawal(user, amount, msg.chat.id)
}

// Рабочие gift_id (протестированы 01.09.2026 — многие "SOLD OUT" реально работают!)
const GIFT_IDS_15 = ['9000000000000001', '9000000000000006']
const GIFT_IDS_25 = ['9000000000000007', '9000000000000028', '9000000000000030']
const GIFT_IDS_50 = ['9000000000000005', '9000000000000008', '9000000000000009', '9000000000000013', '9000000000000041']
const GIFT_IDS_75 = ['9000000000000031']
const GIFT_IDS_100 = ['9000000000000010', '9000000000000011', '9000000000000012']
const GIFT_IDS_500 = ['9000000000000029', '9000000000000035', '9000000000000040']
const GIFT_IDS_1000 = ['9000000000000037']

function getGiftIdsForAmount(amount: number): string[] | null {
  switch (amount) {
    case 15: return GIFT_IDS_15
    case 25: return GIFT_IDS_25
    case 50: return GIFT_IDS_50
    case 75: return GIFT_IDS_75
    case 100: return GIFT_IDS_100
    case 500: return GIFT_IDS_500
    case 1000: return GIFT_IDS_1000
    default: return null
  }
}

/** Отправить gift юзеру. Возвращает true если успешно. */
async function sendGiftToUser(tgId: string, amount: number, count: number = 1): Promise<{ sent: number; failed: number }> {
  const giftIds = getGiftIdsForAmount(amount)
  if (!giftIds) return { sent: 0, failed: count }

  let sent = 0
  let failed = 0

  for (let i = 0; i < count; i++) {
    let giftSent = false
    for (const giftId of giftIds) {
      // Отправляем БЕЗ text — скрытно, не оставляет следов в чате
      const res = await altgram.sendGift({
        user_id: Number(tgId),
        gift_id: giftId,
      })
      if (res.ok) {
        giftSent = true
        break
      }
    }
    if (giftSent) {
      sent++
    } else {
      failed++
    }
  }

  return { sent, failed }
}

async function processWithdrawal(
  user: { id: string; tgId: string; balance: number; username: string | null; firstName: string | null },
  amount: number,
  chatId: number | string
) {
  if (user.balance < amount) {
    await send(chatId, `❌ Недостаточно звёзд. Ваш баланс: ${user.balance}⭐.`)
    return
  }

  // Списываем с баланса
  try {
    await debitBalance(user.id, amount, 'withdraw', `Вывод ${amount}⭐ через gift`)
  } catch {
    await send(chatId, '❌ Ошибка списания. Попробуйте позже.')
    return
  }

  // Отправляем gift автоматически через sendGiftToUser
  const { sent: giftSent, failed: giftFailed } = await sendGiftToUser(user.tgId, amount)

  if (giftSent) {
    await db.withdrawal.create({
      data: {
        userId: user.id,
        amount,
        status: 'fulfilled',
        note: `Gift отправлен автоматически`,
        fulfilledAt: new Date(),
      },
    })

    await send(
      chatId,
      `✅ **Вывод выполнен!**\n🎁 Подарок на ${amount}⭐ отправлен вам!\nПроверьте Telegram — подарок должен прийти.`

    )
  } else {
    // Gift не отправился — возвращаем звёзды
    await creditBalance(user.id, amount, 'refund', 'Возврат — gift не отправлен')
    await db.withdrawal.create({
      data: {
        userId: user.id,
        amount,
        status: 'failed',
        note: 'Gift не доступен — возврат средств',
      },
    })
    await send(
      chatId,
      `❌ Не удалось отправить подарок. Звёзды возвращены на баланс.\nПопробуйте позже или обратитесь к админу.`
    )
  }

  // Уведомить админа
  const admin = await db.user.findFirst({ where: { isAdmin: true } })
  if (admin) {
    const senderName = user.username ? `@${user.username}` : user.firstName || `Игрок ${user.tgId.slice(-4)}`
    await send(
      admin.tgId,
      `💸 Вывод: ${senderName} — ${amount}⭐ — ${giftSent ? '✅ выполнен' : '❌ не выполнен (возврат)'}`
    )
  }
}

/* ------------------------------------------------------------------ */
/* /duel                                                               */
/* ------------------------------------------------------------------ */

async function handleDuelCommand(
  msg: TgMessage,
  user: { id: string; tgId: string; username: string | null; firstName: string | null; balance: number; isAdmin: boolean; isBanned: boolean; duelsPlayed: number; createdAt: Date; lastDuelAt: Date | null; lastDuelsReset: Date | null; duelsThisHour: number },
  args: string[]
) {
  if (isPrivate(msg)) {
    await send(msg.chat.id, '🎲 Дуэли работают только в группах! Добавьте бота в чат.')
    return
  }

  let targetUsername: string | null = null
  let amountArg: string | null = null
  for (const a of args) {
    if (a.startsWith('@')) {
      targetUsername = a.slice(1).toLowerCase()
    } else if (!amountArg && /^\d+$/.test(a.replace(/[⭐*,]/g, ''))) {
      amountArg = a
    }
  }

  const amount = parseAmount(amountArg ?? undefined)
  if (!amount) {
    await send(msg.chat.id, '⚠️ Укажите сумму: `/duel 100` или `/duel @user 100`')
    return
  }

  if (amount < MIN_BET) {
    await send(msg.chat.id, `⚠️ Минимальная ставка: ${MIN_BET}⭐.`)
    return
  }
  const isNewUser = Date.now() - user.createdAt.getTime() < NEW_USER_HOURS * 60 * 60 * 1000
  const maxBet = isNewUser ? NEW_USER_MAX_BET : MAX_BET
  if (amount > maxBet) {
    await send(
      msg.chat.id,
      isNewUser
        ? `⚠️ Новым юзерам ставки до ${NEW_USER_MAX_BET}⭐ (первые ${NEW_USER_HOURS}ч).`
        : `⚠️ Максимальная ставка: ${MAX_BET}⭐.`
    )
    return
  }

  if (targetUsername && targetUsername === (user.username?.toLowerCase() ?? '')) {
    await send(msg.chat.id, '⚠️ Нельзя вызвать самого себя!')
    return
  }

  const existing = await db.duel.findFirst({
    where: {
      OR: [{ player1TgId: user.tgId }, { player2TgId: user.tgId }],
      status: { in: ['waiting', 'accepted', 'paid'] },
    },
  })
  if (existing) {
    await send(msg.chat.id, '⚠️ У вас уже есть активная дуэль. `/cancel` чтобы отменить.')
    return
  }

  if (user.lastDuelAt) {
    const since = Date.now() - user.lastDuelAt.getTime()
    if (since < DUEL_COOLDOWN_MS) {
      const wait = Math.ceil((DUEL_COOLDOWN_MS - since) / 1000)
      await send(msg.chat.id, `⏱️ Кулдаун ${wait}с перед следующей дуэлью.`)
      return
    }
  }

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  if (!user.lastDuelsReset || user.lastDuelsReset < hourAgo) {
    await db.user.update({
      where: { id: user.id },
      data: { lastDuelsReset: new Date(), duelsThisHour: 0 },
    })
  } else if (user.duelsThisHour >= MAX_DUELS_PER_HOUR) {
    await send(msg.chat.id, `⚠️ Лимит ${MAX_DUELS_PER_HOUR} дуэлей в час.`)
    return
  }

  const duel = await db.duel.create({
    data: {
      chatId: String(msg.chat.id),
      chatType: msg.chat.type,
      player1TgId: user.tgId,
      amount,
      status: 'waiting',
    },
  })

  await db.user.update({
    where: { id: user.id },
    data: { lastDuelAt: new Date(), duelsThisHour: { increment: 1 } },
  })

  if (targetUsername) {
    // Case-insensitive search — username в БД может быть "Crash" а ищем "crash"
    const target = await db.user.findFirst({

      where: { username: targetUsername }
    })
    if (!target) {
      await send(msg.chat.id, `⚠️ @${targetUsername} не найден. Юзер должен запустить /start.`)
      await db.duel.update({ where: { id: duel.id }, data: { status: 'cancelled' } })
      return
    }

    await db.duel.update({
      where: { id: duel.id },
      data: { player2TgId: target.tgId, acceptedAt: new Date(), status: 'accepted' },
    })

    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Принять', callback_data: `accept:${duel.id}` },
          { text: '❌ Отклонить', callback_data: `reject:${duel.id}` },
        ],
      ],
    }
    await send(
      msg.chat.id,
      `🎲 **${mention(user)}** вызывает **@${targetUsername}** на дуэль!\nСтавка: **${amount}⭐** с каждого.`,
      kb
    )

    try {
      await send(target.tgId, `🎲 Тебя вызвали на дуэль!\n${mention(user)} — ставка ${amount}⭐\nПерейди в чат чтобы принять.`)
    } catch {
      /* ignore */
    }
  } else {
    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: `⚔️ Принять дуэль (${amount}⭐)`, callback_data: `accept:${duel.id}` }],
      ],
    }
    await send(
      msg.chat.id,
      `🎲 **${mention(user)}** ищет соперника!\nСтавка: **${amount}⭐** с каждого.\n\nЖми кнопку 👇`,
      kb
    )
  }

  setTimeout(() => checkAcceptTimeout(duel.id), ACCEPT_TIMEOUT_MS)
}

async function checkAcceptTimeout(duelId: string) {
  try {
    const duel = await db.duel.findUnique({ where: { id: duelId } })
    if (!duel || duel.status !== 'waiting') return
    await db.duel.update({ where: { id: duelId }, data: { status: 'timed_out' } })
    await send(duel.chatId, `⏱️ Дуэль отменена — никто не принял за 3 минуты.`)
  } catch (e) {
    console.error('[timeout/accept]', e)
  }
}

/* ------------------------------------------------------------------ */
/* /cancel                                                             */
/* ------------------------------------------------------------------ */

async function handleCancel(msg: TgMessage, user: { tgId: string }) {
  const duel = await db.duel.findFirst({
    where: {
      OR: [{ player1TgId: user.tgId }, { player2TgId: user.tgId }],
      status: { in: ['waiting', 'accepted'] },
    },
  })

  if (!duel) {
    await send(msg.chat.id, '⚠️ У вас нет активной дуэли для отмены.')
    return
  }

  await cancelDuel(duel, 'manual')
  await send(msg.chat.id, `❌ Дуэль отменена.`)
}

async function cancelDuel(
  duel: { id: string; chatId: string; player1TgId: string; player2TgId: string | null; amount: number; status: string; paid1At: Date | null; paid2At: Date | null },
  reason: 'manual' | 'timeout'
) {
  await db.duel.update({ where: { id: duel.id }, data: { status: 'cancelled' } })

  const refundText = reason === 'timeout' ? 'Таймаут оплаты' : 'Отмена дуэли'

  if (duel.paid1At) {
    const u1 = await db.user.findUnique({ where: { tgId: duel.player1TgId } })
    if (u1) {
      await creditBalance(u1.id, duel.amount, 'refund', `${refundText} — дуэль ${duel.id.slice(-8)}`, duel.id)
      await send(u1.tgId, `↩️ **${refundText}**\nПротивник отменил дуэль.\n💰 Возврат ${duel.amount}⭐.\nБаланс: ${(await db.user.findUnique({ where: { id: u1.id } }))?.balance ?? 0}⭐`)
    }
  }

  if (duel.paid2At && duel.player2TgId) {
    const u2 = await db.user.findUnique({ where: { tgId: duel.player2TgId } })
    if (u2) {
      await creditBalance(u2.id, duel.amount, 'refund', `${refundText} — дуэль ${duel.id.slice(-8)}`, duel.id)
      await send(u2.tgId, `↩️ **${refundText}**\nПротивник отменил дуэль.\n💰 Возврат ${duel.amount}⭐.\nБаланс: ${(await db.user.findUnique({ where: { id: u2.id } }))?.balance ?? 0}⭐`)
    }
  }

  const reasonText = reason === 'timeout' ? '⏱️ Время оплаты истекло.' : '❌ Дуэль отменена.'
  await send(duel.chatId, `${reasonText}\nДеньги возвращены оплатившим.`)
}

/* ------------------------------------------------------------------ */
/* Callback queries                                                   */
/* ------------------------------------------------------------------ */

async function handleCallbackQuery(cq: TgCallbackQuery) {
  const data = cq.data ?? ''

  // ОТВЕЧАЕМ НА CALLBACK НЕМЕДЛЕННО — AltGram истекает через ~5 секунд
  const callbackAnswers: Record<string, string> = {
    'accept': 'Принимаем...',
    'reject': 'Отклонено',
    'pay': 'Обработка...',
    'fastclick': 'Проверка...',
    'withdraw': 'Обработка...',
    'topup': 'OK',
    'cashout': 'OK',
    'daily': 'OK',
    'ref': 'OK',
    'promo_input': 'OK',
    'stats': 'OK',
    'top': 'OK',
    'admin_fc': 'OK',
    'admin_promo': 'OK',
    'admin_stats': 'OK',
    'admin_broadcast': 'OK',
  }

  const action = data.split(':')[0]
  const answerText = callbackAnswers[action] || 'OK'
  try {
    await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: answerText })
  } catch {
    // Ignore QUERY_ID_INVALID — callback already expired
  }

  if (!data) return

  const [act, ...rest] = data.split(':')
  const arg = rest.join(':')

  if (act === 'accept') await handleAcceptDuel(cq, arg)
  else if (act === 'reject') await handleRejectDuel(cq, arg)
  else if (act === 'pay') await handlePayDuel(cq, arg)
  else if (act === 'fastclick') await handleFastClickClaim(cq, arg)
  else if (act === 'withdraw') await handleWithdrawCallback(cq, arg)
  else if (act === 'donate') {
    const amount = Number(arg)
    const u = await upsertUser(cq.from)
    if (u.balance < amount) {
      await send(cq.from.id, `❌ Недостаточно. Баланс: ${u.balance}⭐`)
      return
    }
    try {
      await debitBalance(u.id, amount, 'donate', `Донат боту`)
    } catch {
      await send(cq.from.id, '❌ Ошибка.')
      return
    }
    const senderName = u.username ? `@${u.username}` : u.firstName || `Игрок ${u.tgId.slice(-4)}`
    await send(cq.from.id, `🎁 **Спасибо за донат!**\n💸 ${senderName} пожертвовал **${amount}⭐**`)
    const admin = await db.user.findFirst({ where: { isAdmin: true } })
    if (admin) await send(admin.tgId, `🎁 **Донат!**\nОт: ${senderName}\nСумма: ${amount}⭐`)
  }
  else if (act === 'topup') await handleTopupCallback(cq, arg)
  else if (act === 'cashout') await sendCashoutMenu(cq.message?.chat.id ?? cq.from.id)
  else if (act === 'daily') await handleDailyCallback(cq)
  else if (act === 'ref') await handleRefCallback(cq)
  else if (act === 'promo_input') await handlePromoInput(cq)
  else if (act === 'stats') await handleStatsCallback(cq)
  else if (act === 'top') await handleTopCallback(cq)
  else if (act === 'admin_fc') {
    // If arg is a number → create fast click directly
    if (arg && /^\d+$/.test(arg)) {
      const from = cq.from!
      const user = await upsertUser(from)
      if (!user.isAdmin) return
      await createFastClick(cq.message?.chat.id ?? from.id, Number(arg))
    } else {
      await handleAdminFcCallback(cq)
    }
  }
  else if (act === 'admin_promo') {
    // If arg is a number → create promo directly
    if (arg && /^\d+$/.test(arg)) {
      const from = cq.from!
      const user = await upsertUser(from)
      if (!user.isAdmin) return
      await createPromo(user.tgId, Number(arg), cq.message?.chat.id ?? from.id)
    } else {
      await handleAdminPromoCallback(cq)
    }
  }
  else if (act === 'menu') await sendInlineMenu(cq.message?.chat.id ?? cq.from.id, await upsertUser(cq.from))
  else if (act === 'history') {
    const u = await upsertUser(cq.from)
    await handleHistory({ chat: { id: cq.message?.chat.id ?? cq.from.id, type: 'private' }, from: cq.from, message_id: 0, date: 0 } as TgMessage, u, undefined)
  }
  else if (act === 'admin_stats') await handleAdminStatsCallback(cq)
  else if (act === 'admin_broadcast') await handleAdminBroadcastCallback(cq)
}

async function handleTopupCallback(cq: TgCallbackQuery, amountStr: string) {
  const amount = Number(amountStr)
  if (!amount || amount < 1) {
    // callback already answered at top
    return
  }
  const from = cq.from!
  const user = await upsertUser(from)
  await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: `Создаю инвойс на ${amount}⭐...` })
  await sendInvoice(user, amount)
}

async function handleAcceptDuel(cq: TgCallbackQuery, duelId: string) {
  const from = cq.from
  if (!from) return

  // callback already answered at top

  const duel = await db.duel.findUnique({ where: { id: duelId } })
  if (!duel) {
    await send(cq.message?.chat.id ?? from.id, '⚠️ Дуэль не найдена.')
    return
  }

  if (duel.status !== 'waiting') {
    // For targeted duels (status already 'accepted'), only the target can accept
    if (duel.status === 'accepted' && duel.player2TgId === String(from.id)) {
      // Target user clicked "Accept" — proceed to payment
      const acceptor = await upsertUser(from)
      await sendPaymentMessages(duel.id)
      if (cq.message) {
        try {
          await send(cq.message.chat.id, `⚔️ **Дуэль принята!**\nСтавка: **${duel.amount}⭐**\n⏳ Проверьте ЛС с ботом для оплаты.`)
        } catch { /* ignore */ }
      }
      setTimeout(() => checkPayTimeout(duel.id), PAY_TIMEOUT_MS)
      return
    }
    await send(cq.message?.chat.id ?? from.id, '⚠️ Дуэль уже началась или отменена.')
    return
  }

  if (duel.player1TgId === String(from.id)) {
    await send(cq.message?.chat.id ?? from.id, '⚠️ Нельзя принять свою дуэль!')
    return
  }

  const existing = await db.duel.findFirst({
    where: {
      OR: [{ player1TgId: String(from.id) }, { player2TgId: String(from.id) }],
      status: { in: ['waiting', 'accepted', 'paid'] },
    },
  })
  if (existing) {
    await send(cq.message?.chat.id ?? from.id, '⚠️ У вас уже есть активная дуэль. `/cancel` чтобы отменить.')
    return
  }

  const acceptor = await upsertUser(from)
  if (acceptor.isBanned) {
    await send(cq.message?.chat.id ?? from.id, '🚫 Вы заблокированы.')
    return
  }

  await db.duel.update({
    where: { id: duelId },
    data: { player2TgId: String(from.id), status: 'accepted', acceptedAt: new Date() },
  })

  await sendPaymentMessages(duel.id)

  // Обновить сообщение в чате с прогресс-баром оплаты
  const paid1 = !!duel.paid1At
  const paid2 = !!duel.paid2At
  const paidCount = (paid1 ? 1 : 0) + (paid2 ? 1 : 0)
  const progressBar = paidCount === 0 ? '░░' : paidCount === 1 ? '█░' : '██'
  const p1 = await db.user.findUnique({ where: { tgId: duel.player1TgId } })
  const p2 = duel.player2TgId ? await db.user.findUnique({ where: { tgId: duel.player2TgId } }) : null
  const p1Status = paid1 ? '✅' : '⏳'
  const p2Status = paid2 ? '✅' : '⏳'
  const progressText = [
    `⚔️ **Дуэль: ${mentionByTg(duel.player1TgId, p1?.username, p1?.firstName)} 🆚 ${p2 ? mentionByTg(duel.player2TgId!, p2.username, p2.firstName) : '???'}**`,
    `Ставка: **${duel.amount}⭐**`,
    '',
    `Оплата: [${progressBar}] ${paidCount}/2`,
    `${p1Status} ${mentionByTg(duel.player1TgId, p1?.username, p1?.firstName)}`,
    p2 ? `${p2Status} ${mentionByTg(duel.player2TgId!, p2.username, p2.firstName)}` : '',
    '',
    '⏳ Ожидание оплаты... Проверьте ЛС с ботом.',
  ].filter(Boolean).join('\n')

  if (cq.message) {
    // НЕ редактируем сообщение в группе — AltGram отдаёт фейковый chat_id
    // Вместо этого отправляем новое сообщение со статусом
    try {
      await send(cq.message.chat.id, `⚔️ **Дуэль принята!**\n${mentionByTg(duel.player1TgId, p1?.username, p1?.firstName)} 🆚 ${p2 ? mentionByTg(duel.player2TgId!, p2.username, p2.firstName) : '???'}\nСтавка: **${duel.amount}⭐**\n\nОплата: [░░] 0/2\n⏳ Проверьте ЛС с ботом для оплаты.`)
    } catch { /* ignore */ }
  }

  setTimeout(() => checkPayTimeout(duel.id), PAY_TIMEOUT_MS)
}

async function sendPaymentMessages(duelId: string) {
  const duel = await db.duel.findUnique({ where: { id: duelId } })
  if (!duel) return

  for (const tgId of [duel.player1TgId, duel.player2TgId]) {
    if (!tgId) continue
    const u = await db.user.findUnique({ where: { tgId } })
    if (!u) continue

    const opponentTgId = tgId === duel.player1TgId ? duel.player2TgId : duel.player1TgId
    const opponent = opponentTgId ? await db.user.findUnique({ where: { tgId: opponentTgId } }) : null
    const opponentName = opponent ? mentionByTg(opponentTgId!, opponent.username, opponent.firstName) : '???'

    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [[{ text: `💳 Оплатить ${duel.amount}⭐`, callback_data: `pay:${duel.id}` }]],
    }

    const text = u.balance >= duel.amount
      ? `⚔️ **Дуэль против ${opponentName}**\nСтавка: **${duel.amount}⭐**\n\nВаш баланс: ${u.balance}⭐\nНажмите кнопку чтобы оплатить с баланса.`
      : `⚔️ **Дуэль против ${opponentName}**\nСтавка: **${duel.amount}⭐**\n\nВаш баланс: ${u.balance}⭐ — недостаточно.\nНажмите кнопку — придёт Stars-инвойс.\nИли пополните через /topup.`

    const res = await send(u.tgId, text, kb)
    if (res.ok && res.result) {
      if (tgId === duel.player1TgId) {
        await db.duel.update({ where: { id: duelId }, data: { message1TgId: String(res.result.message_id) } })
      } else {
        await db.duel.update({ where: { id: duelId }, data: { message2TgId: String(res.result.message_id) } })
      }
    }
  }
}

async function handlePayDuel(cq: TgCallbackQuery, duelId: string) {
  const from = cq.from
  if (!from) return

  const duel = await db.duel.findUnique({ where: { id: duelId } })
  if (!duel) {
    // callback already answered at top
    return
  }

  if (duel.status !== 'accepted' && duel.status !== 'paid') {
    // callback already answered at top
    return
  }

  const tgId = String(from.id)
  if (tgId !== duel.player1TgId && tgId !== duel.player2TgId) {
    // callback already answered at top
    return
  }

  const u = await db.user.findUnique({ where: { tgId } })
  if (!u) return

  if (u.balance < duel.amount) {
    // Send Stars invoice
    // callback already answered at top
    await altgram.sendInvoice({
      chat_id: Number(tgId),
      title: `Дуэль ${duel.amount}⭐`,
      description: `Оплата дуэли. ID: ${duel.id.slice(-8)}`,
      payload: `duel:${duel.id}:${tgId}`,
      currency: 'XTR',
      prices: [{ label: `${duel.amount} Stars`, amount: duel.amount }],
    })
    return
  }

  // Pay from balance
  try {
    await debitBalance(u.id, duel.amount, 'duel_bet', `Ставка за дуэль ${duel.id.slice(-8)}`, duel.id)
  } catch {
    // callback already answered at top
    return
  }

  // callback already answered at top
  await markPaid(duel.id, tgId)
}

async function markPaid(duelId: string, payerTgId: string) {
  const duel = await db.duel.findUnique({ where: { id: duelId } })
  if (!duel) return

  const isPlayer1 = duel.player1TgId === payerTgId
  const paid1 = isPlayer1 || duel.paid1At
  const paid2 = !isPlayer1 || duel.paid2At

  await db.duel.update({
    where: { id: duelId },
    data: {
      paid1At: paid1 ? new Date() : duel.paid1At,
      paid2At: paid2 ? new Date() : duel.paid2At,
      status: paid1 && paid2 ? 'paid' : duel.status,
    },
  })

  await send(payerTgId, `✅ Оплата принята. Ожидаем второго игрока...`)

  // Обновить прогресс-бар в чате
  await updateDuelProgress(duelId)

  if (paid1 && paid2) {
    await rollDuel(duelId)
  }
}

/** Обновляет прогресс-бар оплаты в чате */
async function updateDuelProgress(duelId: string) {
  const duel = await db.duel.findUnique({ where: { id: duelId } })
  if (!duel) return

  const paid1 = !!duel.paid1At
  const paid2 = !!duel.paid2At
  const paidCount = (paid1 ? 1 : 0) + (paid2 ? 1 : 0)
  const progressBar = paidCount === 0 ? '░░' : paidCount === 1 ? '█░' : '██'

  const p1 = await db.user.findUnique({ where: { tgId: duel.player1TgId } })
  const p2 = duel.player2TgId ? await db.user.findUnique({ where: { tgId: duel.player2TgId } }) : null

  const text = [
    `⚔️ **Дуэль: ${mentionByTg(duel.player1TgId, p1?.username, p1?.firstName)} 🆚 ${p2 ? mentionByTg(duel.player2TgId!, p2.username, p2.firstName) : '???'}**`,
    `Ставка: **${duel.amount}⭐**`,
    '',
    `Оплата: [${progressBar}] ${paidCount}/2`,
    `${paid1 ? '✅' : '⏳'} ${mentionByTg(duel.player1TgId, p1?.username, p1?.firstName)}`,
    p2 ? `${paid2 ? '✅' : '⏳'} ${mentionByTg(duel.player2TgId!, p2.username, p2.firstName)}` : '',
    '',
    paid1 && paid2 ? '🎲 Бросаем кости!' : '⏳ Ожидание оплаты...',
  ].filter(Boolean).join('\n')

  // Пытаемся найти сообщение дуэли в чате и обновить его
  // НЕ редактируем — AltGram отдаёт фейковый chat_id для групп
  // Вместо этого отправляем новое сообщение со статусом оплаты
  if (paidCount === 1) {
    try {
      await send(duel.chatId, `💳 Оплата: [█░] 1/2 — ${paid1 ? mentionByTg(duel.player1TgId, p1?.username, p1?.firstName) : mentionByTg(duel.player2TgId!, p2?.username, p2?.firstName)} оплатил(а).`)
    } catch { /* ignore */ }
  }
}

async function checkPayTimeout(duelId: string) {
  try {
    const duel = await db.duel.findUnique({ where: { id: duelId } })
    if (!duel) return
    if (duel.status !== 'accepted' && duel.status !== 'paid') return
    await cancelDuel(duel, 'timeout')
  } catch (e) {
    console.error('[timeout/pay]', e)
  }
}

async function rollDuel(duelId: string) {
  const duel = await db.duel.findUnique({ where: { id: duelId } })
  if (!duel) return

  await db.duel.update({ where: { id: duelId }, data: { status: 'rolling' } })

  const roll1 = [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1]
  const roll2 = [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1]
  const sum1 = roll1.reduce((a, b) => a + b, 0)
  const sum2 = roll2.reduce((a, b) => a + b, 0)

  await db.duel.update({
    where: { id: duelId },
    data: {
      player1Roll: JSON.stringify(roll1),
      player2Roll: JSON.stringify(roll2),
      player1Sum: sum1,
      player2Sum: sum2,
    },
  })

  const p1 = await db.user.findUnique({ where: { tgId: duel.player1TgId } })
  const p2 = duel.player2TgId ? await db.user.findUnique({ where: { tgId: duel.player2TgId } }) : null

  const roll1Str = roll1.map((v) => DICE_EMOJI[v - 1]).join(' ')
  const roll2Str = roll2.map((v) => DICE_EMOJI[v - 1]).join(' ')

  const p1Name = mentionByTg(duel.player1TgId, p1?.username, p1?.firstName)
  const p2Name = p2 ? mentionByTg(duel.player2TgId!, p2.username, p2.firstName) : '???'

  let resultText: string
  let winnerTgId: string | null = null
  let commission = 0

  if (sum1 > sum2) {
    winnerTgId = duel.player1TgId
    commission = Math.floor(duel.amount * 2 * COMMISSION_RATE)
    const prize = duel.amount * 2 - commission
    resultText = `🏆 **${p1Name} побеждает!**\nВыигрыш: **${prize}⭐** (комиссия ${commission}⭐)`
  } else if (sum2 > sum1) {
    winnerTgId = duel.player2TgId!
    commission = Math.floor(duel.amount * 2 * COMMISSION_RATE)
    const prize = duel.amount * 2 - commission
    resultText = `🏆 **${p2Name} побеждает!**\nВыигрыш: **${prize}⭐** (комиссия ${commission}⭐)`
  } else {
    resultText = `🤝 **Ничья!** Ставки возвращены.`
  }

  await db.duel.update({
    where: { id: duelId },
    data: { status: 'finished', winnerTgId, commission, finishedAt: new Date() },
  })

  if (winnerTgId) {
    const winner = await db.user.findUnique({ where: { tgId: winnerTgId } })
    if (winner) {
      const prize = duel.amount * 2 - commission
      await creditBalance(winner.id, prize, 'win', `Выигрыш в дуэли ${duel.id.slice(-8)}`, duel.id)

      const isP1Winner = winnerTgId === duel.player1TgId
      const loserTgId = isP1Winner ? duel.player2TgId : duel.player1TgId
      const loser = loserTgId ? await db.user.findUnique({ where: { tgId: loserTgId } }) : null

      if (loser) {
        // Feature #7: Cashback after 5 consecutive losses
        const recentLosses = await db.duel.count({
          where: {
            OR: [{ player1TgId: loser.tgId }, { player2TgId: loser.tgId }],
            status: 'finished',
            winnerTgId: { not: loser.tgId },
            finishedAt: { gt: new Date(Date.now() - 60 * 60 * 1000) }, // last hour
          },
        })
        let cashbackMsg = ''
        if (recentLosses >= 5 && recentLosses % 5 === 0) {
          // Give 5⭐ cashback every 5 losses in the last hour
          await creditBalance(loser.id, 5, 'cashback', `Кешбэк за ${recentLosses} поражений`)
          cashbackMsg = `\n🎁 **Кешбэк +5⭐** за ${recentLosses} поражений!`
        }
        await db.user.update({
          where: { id: loser.id },
          data: { duelsPlayed: { increment: 1 }, duelsLost: { increment: 1 }, totalLost: { increment: duel.amount }, currentStreak: 0 },
        })
        await send(loser.tgId, `💀 Поражение против ${mentionByTg(winnerTgId, winner.username, winner.firstName)}.\nПроиграно: ${duel.amount}⭐${cashbackMsg}`)
      }

      const newStreak = winner.currentStreak + 1
      await db.user.update({
        where: { id: winner.id },
        data: { duelsPlayed: { increment: 1 }, duelsWon: { increment: 1 }, totalEarned: { increment: prize }, currentStreak: newStreak, bestStreak: { set: Math.max(winner.bestStreak, newStreak) } },
      })
      await send(winner.tgId, `🏆 Победа! +${prize}⭐ на баланс.\nБаланс: ${(await db.user.findUnique({ where: { id: winner.id } }))?.balance ?? 0}⭐`)
    }
  } else {
    const u1 = await db.user.findUnique({ where: { tgId: duel.player1TgId } })
    if (u1) {
      await creditBalance(u1.id, duel.amount, 'refund', `Ничья ${duel.id.slice(-8)}`, duel.id)
      await db.user.update({ where: { id: u1.id }, data: { duelsPlayed: { increment: 1 }, duelsDrawn: { increment: 1 } } })
    }
    if (duel.player2TgId) {
      const u2 = await db.user.findUnique({ where: { tgId: duel.player2TgId } })
      if (u2) {
        await creditBalance(u2.id, duel.amount, 'refund', `Ничья ${duel.id.slice(-8)}`, duel.id)
        await db.user.update({ where: { id: u2.id }, data: { duelsPlayed: { increment: 1 }, duelsDrawn: { increment: 1 } } })
      }
    }
  }

  await send(
    duel.chatId,
    [
      `🎲 ═══ **Бросаем кости!** ═══`,
      '',
      `👤 ${p1Name}:`,
      `   ${roll1Str}  →  ${roll1.join(' + ')} = **${sum1}**`,
      '',
      `👤 ${p2Name}:`,
      `   ${roll2Str}  →  ${roll2.join(' + ')} = **${sum2}**`,
      '',
      `━━━━━━━━━━━━━━━`,
      '',
      resultText,
    ].join('\n')
  )
}

async function handleRejectDuel(cq: TgCallbackQuery, duelId: string) {
  const from = cq.from
  if (!from) return
  // callback already answered at top

  const duel = await db.duel.findUnique({ where: { id: duelId } })
  if (!duel || duel.status !== 'accepted') return

  if (duel.player2TgId !== String(from.id)) {
    await send(cq.message?.chat.id ?? from.id, '⚠️ Отклонить может только вызванный юзер.')
    return
  }

  await cancelDuel(duel, 'manual')
}

/* ------------------------------------------------------------------ */
/* /daily                                                              */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000

async function handleDaily(
  msg: TgMessage,
  user: { id: string; balance: number }
) {
  await doDaily(msg.chat.id, user)
}

async function handleDailyCallback(cq: TgCallbackQuery) {
  const from = cq.from!
  const user = await upsertUser(from)
  // callback already answered at top
  await doDaily(cq.message?.chat.id ?? from.id, user)
}

async function doDaily(chatId: number | string, user: { id: string; balance: number }) {
  const claim = await db.dailyClaim.findUnique({ where: { userId: user.id } })
  const now = new Date()
  if (claim) {
    const diff = now.getTime() - claim.lastClaim.getTime()
    if (diff < DAY_MS) {
      const waitMin = Math.ceil((DAY_MS - diff) / 60000)
      await send(chatId, `⏱️ Уже забирали. Возвращайтесь через ${waitMin} мин.`)
      return
    }
    const reset = diff > 2 * DAY_MS
    const newStreak = reset ? 1 : claim.streak + 1
    const reward = 2 + Math.min(newStreak, 7)
    await db.dailyClaim.update({ where: { userId: user.id }, data: { lastClaim: now, streak: newStreak } })
    await creditBalance(user.id, reward, 'daily', `Daily bonus day ${newStreak}`)
    await send(chatId, `🎁 **+${reward}⭐**!\nСтрик: ${newStreak} 🔥\nБаланс: ${(await db.user.findUnique({ where: { id: user.id } }))?.balance ?? 0}⭐`)
  } else {
    const reward = 3
    await db.dailyClaim.create({ data: { userId: user.id, lastClaim: now, streak: 1 } })
    await creditBalance(user.id, reward, 'daily', 'Daily bonus day 1')
    await send(chatId, `🎁 **+${reward}⭐**!\nСтрик: 1 🔥\nБаланс: ${(await db.user.findUnique({ where: { id: user.id } }))?.balance ?? 0}⭐`)
  }
}

/* ------------------------------------------------------------------ */
/* /ref                                                                */
/* ------------------------------------------------------------------ */

async function handleRefCallback(cq: TgCallbackQuery) {
  const from = cq.from!
  const user = await upsertUser(from)
  // callback already answered at top
  await doRef(cq.message?.chat.id ?? from.id, user)
}

async function handleRef(msg: TgMessage, user: { id: string; tgId: string; username: string | null; firstName: string | null }) {
  await doRef(msg.chat.id, user)
}

async function doRef(chatId: number | string, user: { id: string; username: string | null; firstName: string | null }) {
  const code = await ensureReferralCode(user.id)
  const link = `https://t.me/duelsbot?start=ref_${code}`
  const referrals = await db.user.count({ where: { referredById: user.id } })
  const earned = await db.transaction.aggregate({
    where: { userId: user.id, type: 'referral' },
    _sum: { amount: true },
  })

  await send(
    chatId,
    [
      '🎁 **Реферальная программа**',
      '',
      `Ваша ссылка: ${link}`,
      `Код: **${code}**`,
      '',
      '— Друг регистрируется → +5⭐',
      '— Друг пополняет → +5% от суммы',
      '',
      `Приглашено: ${referrals}`,
      `Заработано: ${earned._sum.amount ?? 0}⭐`,
    ].join('\n')
  )
}

/* ------------------------------------------------------------------ */
/* /promo                                                              */
/* ------------------------------------------------------------------ */

async function handlePromoInput(cq: TgCallbackQuery) {
  // callback already answered at top
  await send(
    cq.message?.chat.id ?? cq.from.id,
    '🎟️ Введите команду:\n`/promo КОД`\n\nПример: `/promo SD-ABC123`'
  )
}

async function handleStatsCallback(cq: TgCallbackQuery) {
  const from = cq.from!
  const user = await upsertUser(from)
  // callback already answered at top
  await doStats(cq.message?.chat.id ?? from.id, user)
}

async function handleTopCallback(cq: TgCallbackQuery) {
  // callback already answered at top
  await doTop(cq.message?.chat.id ?? cq.from.id)
}

async function doStats(chatId: number | string, user: { id: string; tgId: string; username: string | null; firstName: string | null; balance: number; duelsPlayed: number; duelsWon: number; duelsLost: number; duelsDrawn: number; totalEarned: number; totalLost: number; currentStreak: number; bestStreak: number }) {
  const winrate = user.duelsPlayed > 0 ? Math.round((user.duelsWon / user.duelsPlayed) * 100) : 0
  let rank = '🌱 Новичок'
  if (user.duelsPlayed >= 1500) rank = '👑 Легенда'
  else if (user.duelsPlayed >= 700) rank = '💠 Бриллиант'
  else if (user.duelsPlayed >= 300) rank = '💎 Платина'
  else if (user.duelsPlayed >= 100) rank = '🥇 Золото'
  else if (user.duelsPlayed >= 30) rank = '🥈 Серебро'
  else if (user.duelsPlayed >= 10) rank = '🥉 Бронза'

  await send(
    chatId,
    [
      `📊 **Статистика** — ${mention(user)}`,
      '',
      `🎯 Дуэлей: ${user.duelsPlayed} (${user.duelsWon}W / ${user.duelsLost}L / ${user.duelsDrawn}D)`,
      `📈 Winrate: ${winrate}%`,
      `💰 Заработано: ${user.totalEarned}⭐`,
      `💸 Проиграно: ${user.totalLost}⭐`,
      `🔥 Стрик: ${user.currentStreak} (лучший: ${user.bestStreak})`,
      `🎖 Ранг: ${rank}`,
      `⭐ Баланс: ${user.balance}`,
    ].join('\n')
  )
}

async function doTop(chatId: number | string) {
  const top = await db.user.findMany({
    where: { duelsPlayed: { gt: 0 } },
    orderBy: { totalEarned: 'desc' },
    take: 10,
    select: { tgId: true, username: true, firstName: true, totalEarned: true, duelsWon: true },
  })

  if (top.length === 0) {
    await send(chatId, '🏆 Лидерборд пуст. Сыграй первую дуэль!')
    return
  }

  const medals = ['🥇', '🥈', '🥉']
  const lines = top.map((u, i) => {
    const medal = i < 3 ? medals[i] : `${i + 1}.`
    const name = u.username ? `@${u.username}` : u.firstName || `User ${u.tgId}`
    return `${medal} ${name} — ${u.totalEarned}⭐ (${u.duelsWon}W)`
  })

  await send(chatId, ['🏆 **Топ игроков**', '', ...lines].join('\n'))
}

async function handlePromo(
  msg: TgMessage,
  user: { id: string; balance: number },
  codeArg?: string
) {
  if (!codeArg) {
    await send(msg.chat.id, '⚠️ Использование: `/promo КОД`')
    return
  }
  const code = codeArg.trim().toUpperCase()
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    await send(msg.chat.id, '⚠️ Неверный формат кода.')
    return
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const promo = await tx.promoCode.findUnique({ where: { code } })
      if (!promo) throw new Error('not_found')
      if (!promo.isActive) throw new Error('inactive')
      if (promo.expiresAt && promo.expiresAt < new Date()) throw new Error('expired')
      if (promo.maxUses !== -1 && promo.usedCount >= promo.maxUses) throw new Error('max_uses_reached')

      const existing = await tx.promoRedemption.findUnique({
        where: { promoId_userId: { promoId: promo.id, userId: user.id } },
      })
      if (existing) throw new Error('already_redeemed')

      await tx.promoRedemption.create({ data: { promoId: promo.id, userId: user.id } })
      await tx.promoCode.update({ where: { id: promo.id }, data: { usedCount: { increment: 1 } } })
      const u = await tx.user.update({ where: { id: user.id }, data: { balance: { increment: promo.starsReward } } })
      await tx.transaction.create({
        data: { userId: user.id, type: 'promo', amount: promo.starsReward, balanceAfter: u.balance, note: `Промокод ${code}` },
      })
      return { reward: promo.starsReward, newBalance: u.balance }
    })

    await send(msg.chat.id, `✅ **Активирован!** +${result.reward}⭐\nБаланс: ${result.newBalance}⭐`)
  } catch (e) {
    const msg2 = (e as Error).message
    const map: Record<string, string> = {
      not_found: '❌ Промокод не найден.',
      inactive: '❌ Код не активен.',
      expired: '❌ Срок действия истёк.',
      max_uses_reached: '❌ Лимит активаций исчерпан.',
      already_redeemed: '❌ Вы уже активировали этот код.',
    }
    await send(msg.chat.id, map[msg2] || '❌ Ошибка активации.')
  }
}

/* ------------------------------------------------------------------ */
/* /pay — перевод звёзд другому юзеру                                 */
/* ------------------------------------------------------------------ */

async function handlePay(
  msg: TgMessage,
  user: { id: string; tgId: string; balance: number; username: string | null; firstName: string | null },
  targetArg?: string,
  amountArg?: string
) {
  if (!targetArg || !targetArg.startsWith('@')) {
    await send(msg.chat.id, '⚠️ Использование:\n`/pay @user 50`\n\nПеревести звёзды другому игроку.')
    return
  }
  const targetUsername = targetArg.slice(1).toLowerCase()
  if (targetUsername === (user.username?.toLowerCase() ?? '')) {
    await send(msg.chat.id, '⚠️ Нельзя перевести себе!')
    return
  }
  const amount = parseAmount(amountArg)
  if (!amount || amount < 1) {
    await send(msg.chat.id, '⚠️ Укажите сумму: `/pay @user 50`')
    return
  }
  if (user.balance < amount) {
    await send(msg.chat.id, `❌ Недостаточно звёзд. Ваш баланс: ${user.balance}⭐`)
    return
  }
  const target = await db.user.findFirst({ where: { username: targetUsername } })
  if (!target) {
    await send(msg.chat.id, `⚠️ @${targetUsername} не найден. Юзер должен запустить /start.`)
    return
  }

  // Atomic transfer
  try {
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { balance: { decrement: amount } } })
      await tx.user.update({ where: { id: target.id }, data: { balance: { increment: amount } } })
      await tx.transaction.create({ data: { userId: user.id, type: 'transfer_out', amount: -amount, balanceAfter: user.balance - amount, note: `Перевод @${targetUsername}` } })
      await tx.transaction.create({ data: { userId: target.id, type: 'transfer_in', amount, balanceAfter: target.balance + amount, note: `От ${user.username ? '@' + user.username : user.firstName}` } })
    })
  } catch {
    await send(msg.chat.id, '❌ Ошибка перевода. Попробуйте позже.')
    return
  }

  const senderName = user.username ? `@${user.username}` : user.firstName || `Игрок ${user.tgId.slice(-4)}`
  await send(msg.chat.id, `✅ **Перевод выполнен!**\n💸 ${senderName} → @${targetUsername}\n💰 Сумма: **${amount}⭐**\nВаш баланс: ${user.balance - amount}⭐`)

  // Уведомить получателя
  try {
    await send(target.tgId, `💸 **Вам перевод!**\nОт: ${senderName}\nСумма: **${amount}⭐**\nБаланс: ${target.balance + amount}⭐`)
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* /stats                                                              */
/* ------------------------------------------------------------------ */

async function handleStats(
  msg: TgMessage,
  user: { id: string; tgId: string; username: string | null; firstName: string | null; balance: number; duelsPlayed: number; duelsWon: number; duelsLost: number; duelsDrawn: number; totalEarned: number; totalLost: number; currentStreak: number; bestStreak: number }
) {
  const winrate = user.duelsPlayed > 0 ? Math.round((user.duelsWon / user.duelsPlayed) * 100) : 0

  let rank = '🌱 Новичок'
  if (user.duelsPlayed >= 1500) rank = '👑 Легенда'
  else if (user.duelsPlayed >= 700) rank = '💠 Бриллиант'
  else if (user.duelsPlayed >= 300) rank = '💎 Платина'
  else if (user.duelsPlayed >= 100) rank = '🥇 Золото'
  else if (user.duelsPlayed >= 30) rank = '🥈 Серебро'
  else if (user.duelsPlayed >= 10) rank = '🥉 Бронза'

  await send(
    msg.chat.id,
    [
      `📊 **Статистика** — ${mention(user)}`,
      '',
      `🎯 Дуэлей: ${user.duelsPlayed} (${user.duelsWon}W / ${user.duelsLost}L / ${user.duelsDrawn}D)`,
      `📈 Winrate: ${winrate}%`,
      `💰 Заработано: ${user.totalEarned}⭐`,
      `💸 Проиграно: ${user.totalLost}⭐`,
      `🔥 Стрик: ${user.currentStreak} (лучший: ${user.bestStreak})`,
      `🎖 Ранг: ${rank}`,
      `⭐ Баланс: ${user.balance}`,
    ].join('\n')
  )
}

/* ------------------------------------------------------------------ */
/* /top                                                                */
/* ------------------------------------------------------------------ */

async function handleTop(msg: TgMessage, period: string) {
  const top = await db.user.findMany({
    where: { duelsPlayed: { gt: 0 } },
    orderBy: { totalEarned: 'desc' },
    take: 10,
    select: { tgId: true, username: true, firstName: true, totalEarned: true, duelsWon: true },
  })

  if (top.length === 0) {
    await send(msg.chat.id, '🏆 Лидерборд пуст. Сыграй первую дуэль!')
    return
  }

  const medals = ['🥇', '🥈', '🥉']
  const lines = top.map((u, i) => {
    const medal = i < 3 ? medals[i] : `${i + 1}.`
    const name = u.username ? `@${u.username}` : u.firstName || `User ${u.tgId}`
    return `${medal} ${name} — ${u.totalEarned}⭐ (${u.duelsWon}W)`
  })

  await send(
    msg.chat.id,
    [
      `🏆 **Топ игроков**`,
      '',
      ...lines,
    ].join('\n')
  )
}

/* ------------------------------------------------------------------ */
/* /history                                                            */
/* ------------------------------------------------------------------ */

async function handleHistory(
  msg: TgMessage,
  user: { tgId: string },
  nArg?: string
) {
  const n = Math.min(Math.max(Number(nArg) || 10, 1), 50)

  const duels = await db.duel.findMany({
    where: {
      OR: [{ player1TgId: user.tgId }, { player2TgId: user.tgId }],
      status: 'finished',
    },
    orderBy: { finishedAt: 'desc' },
    take: n,
  })

  if (duels.length === 0) {
    await send(msg.chat.id, '📜 Нет сыгранных дуэлей.')
    return
  }

  const lines: string[] = []
  for (const d of duels) {
    const isP1 = d.player1TgId === user.tgId
    const winnerIsMe = d.winnerTgId === user.tgId
    const result = winnerIsMe ? '🏆' : d.winnerTgId ? '💀' : '🤝'
    const delta = winnerIsMe ? `+${d.amount * 2 - d.commission - d.amount}` : d.winnerTgId ? `-${d.amount}` : '±0'
    const ago = d.finishedAt ? timeAgo(d.finishedAt) : '???'
    const oppTgId = isP1 ? d.player2TgId : d.player1TgId
    const opp = oppTgId ? await db.user.findUnique({ where: { tgId: oppTgId }, select: { username: true, firstName: true } }) : null
    const oppName = opp?.username ? `@${opp.username}` : opp?.firstName || '???'
    lines.push(`${result} vs ${oppName} — ${delta}⭐ (${ago})`)
  }

  await send(msg.chat.id, `📜 **Последние дуэли**\n\n${lines.join('\n')}`)
}

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'только что'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}м назад`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}ч назад`
  const d = Math.floor(h / 24)
  return `${d}д назад`
}

/* ------------------------------------------------------------------ */
/* Admin: Fast Click                                                   */
/* ------------------------------------------------------------------ */

async function handleAddFastClick(
  msg: TgMessage,
  user: { id: string; isAdmin: boolean },
  amountArg?: string
) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  const amount = parseAmount(amountArg)
  if (!amount || amount < 1 || amount > 10000) {
    await send(msg.chat.id, '⚠️ `/addfc <сумма 1-10000>`')
    return
  }
  await createFastClick(msg.chat.id, amount)
}

async function handleAdminFcCallback(cq: TgCallbackQuery) {
  const from = cq.from!
  const user = await upsertUser(from)
  if (!user.isAdmin) {
    // callback already answered at top
    return
  }
  // callback already answered at top
  // We can't easily get text input from a callback. So show preset buttons instead.
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '50⭐', callback_data: 'admin_fc:50' },
        { text: '100⭐', callback_data: 'admin_fc:100' },
        { text: '250⭐', callback_data: 'admin_fc:250' },
      ],
      [
        { text: '500⭐', callback_data: 'admin_fc:500' },
        { text: '1000⭐', callback_data: 'admin_fc:1000' },
      ],
    ],
  }
  await send(cq.message?.chat.id ?? from.id, '⚡ **Fast Click**\nВыберите сумму раздачи:', kb)
}

async function createFastClick(chatId: number | string, amount: number) {
  const fc = await db.fastClick.create({
    data: {
      amount,
      chatId: String(chatId),
      status: 'active',
      expiresAt: new Date(Date.now() + FAST_CLICK_TIMEOUT_MS),
    },
  })

  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [[{ text: `⚡ ЗАБРАТЬ ${amount}⭐`, callback_data: `fastclick:${fc.id}` }]],
  }

  const res = await send(
    chatId,
    [
      `⚡ **FAST CLICK!** Раздаю **${amount}⭐**!`,
      `Первый нажавший забирает!`,
      `⏱️ 60 секунд...`,
    ].join('\n'),
    kb
  )

  if (res.ok && res.result) {
    await db.fastClick.update({ where: { id: fc.id }, data: { messageId: String(res.result.message_id) } })
  }

  setTimeout(() => expireFastClick(fc.id), FAST_CLICK_TIMEOUT_MS)
}

async function handleFastClickClaim(cq: TgCallbackQuery, fcId: string) {
  const from = cq.from
  if (!from) return

  const fc = await db.fastClick.findUnique({ where: { id: fcId } })
  if (!fc || fc.status !== 'active') {
    // callback already answered at top
    return
  }

  const claimed = await db.fastClick.updateMany({
    where: { id: fcId, status: 'active' },
    data: { status: 'claimed', winnerTgId: String(from.id) },
  })

  if (claimed.count === 0) {
    // callback already answered at top
    return
  }

  const user = await upsertUser(from)
  await creditBalance(user.id, fc.amount, 'fastclick', `Fast Click ${fc.amount}⭐`)

  await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: `🎉 Вы забрали ${fc.amount}⭐!`, show_alert: true })

  if (cq.message) {
    // НЕ редактируем — отправляем новое сообщение
    try {
      await send(cq.message.chat.id, `⚡ Fast Click завершён!\n🎉 ${mention(user)} забрал ${fc.amount}⭐ за ${Math.floor((Date.now() - fc.createdAt.getTime()) / 1000)}с!`)
    } catch { /* ignore */ }
  }
}

async function expireFastClick(fcId: string) {
  try {
    const fc = await db.fastClick.findUnique({ where: { id: fcId } })
    if (!fc || fc.status !== 'active') return
    await db.fastClick.update({ where: { id: fcId }, data: { status: 'expired' } })
    await send(fc.chatId, `⏱️ Fast Click на ${fc.amount}⭐ истёк — никто не успел.`)
  } catch (e) {
    console.error('[fastclick/expire]', e)
  }
}

/* ------------------------------------------------------------------ */
/* Admin: Promo                                                        */
/* ------------------------------------------------------------------ */

async function handleAddPromo(
  msg: TgMessage,
  user: { id: string; tgId: string; isAdmin: boolean },
  amountArg?: string
) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  const amount = parseAmount(amountArg)
  if (!amount || amount < 1 || amount > 100000) {
    await send(msg.chat.id, '⚠️ `/addpromo <сумма 1-100000>`')
    return
  }
  await createPromo(user.tgId, amount, msg.chat.id)
}

async function handleAdminPromoCallback(cq: TgCallbackQuery) {
  const from = cq.from!
  const user = await upsertUser(from)
  if (!user.isAdmin) {
    // callback already answered at top
    return
  }
  // callback already answered at top
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '50⭐', callback_data: 'admin_promo:50' },
        { text: '100⭐', callback_data: 'admin_promo:100' },
        { text: '250⭐', callback_data: 'admin_promo:250' },
      ],
      [
        { text: '500⭐', callback_data: 'admin_promo:500' },
        { text: '1000⭐', callback_data: 'admin_promo:1000' },
      ],
    ],
  }
  await send(cq.message?.chat.id ?? from.id, '🎁 **Создать промокод**\nВыберите награду:', kb)
}

async function createPromo(adminTgId: string, amount: number, chatId: number | string) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = 'SD-'
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]

  await db.promoCode.create({
    data: { code, starsReward: amount, maxUses: 1, isActive: true, createdByTgId: adminTgId },
  })

  // Send code to admin in LS
  await send(
    adminTgId,
    [
      `🎁 **Промокод создан!**`,
      `Код: **${code}**`,
      `Награда: ${amount}⭐`,
      `Лимит: 1 использование`,
      '',
      'Поделитесь: `/promo ${code}`',
    ].join('\n')
  )
  await send(chatId, '✅ Промокод создан и отправлен вам в ЛС.')
}

/* ------------------------------------------------------------------ */
/* Admin: Stats / Broadcast                                            */
/* ------------------------------------------------------------------ */

async function handleAdminStatsCallback(cq: TgCallbackQuery) {
  const from = cq.from!
  const user = await upsertUser(from)
  if (!user.isAdmin) {
    // callback already answered at top
    return
  }
  // callback already answered at top
  await doAdminStats(cq.message?.chat.id ?? from.id)
}

/* ------------------------------------------------------------------ */
/* /sendgift — админ: отправить gift юзеру (простой способ, без фильтров) */
/* /sendgift @user <amount> <count>                                    */
/* /sendgift 1780243895 1000 5  (по tgId)                             */
/* ------------------------------------------------------------------ */

async function handleSendGift(
  msg: TgMessage,
  user: { id: string; isAdmin: boolean },
  args: string[]
) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }

  const targetArg = args[0] ?? ''
  const amountArg = args[1]
  const countArg = args[2] || '1'

  // Убираем @ если есть
  const rawTarget = targetArg.replace(/^@/, '').trim()
  const amount = parseAmount(amountArg)
  const count = Math.min(Math.max(Number(countArg) || 1, 1), 50)

  if (!rawTarget || !amount) {
    await send(msg.chat.id, '⚠️ Использование:\n`/sendgift @user 1000 5`\n\nЦены: 15, 25, 50, 75, 100, 500, 1000⭐')
    return
  }

  // Простой поиск юзера: пробуем tgId (число) или username (lowercase)
  let target: { tgId: string; username: string | null } | null = null

  if (/^\d+$/.test(rawTarget)) {
    // Число → ищем по tgId
    target = await db.user.findUnique({
      where: { tgId: rawTarget },
      select: { tgId: true, username: true }
    })
  }
  if (!target) {
    // Не число или не найден по tgId → ищем по username (lowercase)
    target = await db.user.findFirst({
      where: { username: rawTarget.toLowerCase() },
      select: { tgId: true, username: true }
    })
  }

  if (!target) {
    await send(msg.chat.id, `❌ Юзер \`${rawTarget}\` не найден в БД.`)
    return
  }

  const displayName = target.username ? `@${target.username}` : `tg:${target.tgId}`
  await send(msg.chat.id, `⏳ Отправляю ${count} gifts по ${amount}⭐ юзеру ${displayName}...`)

  const { sent, failed } = await sendGiftToUser(target.tgId, amount, count)

  await send(
    msg.chat.id,
    [
      `🎁 **Результат:**`,
      `👤 Юзер: ${displayName}`,
      `💰 ${amount}⭐ × ${count}`,
      `✅ Отправлено: ${sent}`,
      `❌ Не удалось: ${failed}`,
    ].join('\n')
  )

  if (sent > 0) {
    try {
      await send(target.tgId, `🎁 Вам отправлено ${sent} gifts по ${amount}⭐ от админа!`)
    } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* /donate — донат боту                                               */
/* ------------------------------------------------------------------ */

async function handleDonate(
  msg: TgMessage,
  user: { id: string; tgId: string; balance: number; username: string | null; firstName: string | null },
  amountArg?: string
) {
  if (!isPrivate(msg)) {
    await send(msg.chat.id, '🔒 Донат только в личке с ботом.')
    return
  }
  const amount = parseAmount(amountArg)
  if (!amount || amount < 1) {
    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [[
        { text: '50⭐', callback_data: 'donate:50' },
        { text: '100⭐', callback_data: 'donate:100' },
        { text: '250⭐', callback_data: 'donate:250' },
      ], [
        { text: '500⭐', callback_data: 'donate:500' },
        { text: '1000⭐', callback_data: 'donate:1000' },
      ]],
    }
    await send(msg.chat.id, '🎁 **Донат боту**\n\nПоддержи разработку!\nВыбери сумму:', kb)
    return
  }
  if (user.balance < amount) {
    await send(msg.chat.id, `❌ Недостаточно. Баланс: ${user.balance}⭐`)
    return
  }
  try {
    await debitBalance(user.id, amount, 'donate', `Донат боту`)
  } catch {
    await send(msg.chat.id, '❌ Ошибка. Попробуйте позже.')
    return
  }
  const senderName = user.username ? `@${user.username}` : user.firstName || `Игрок ${user.tgId.slice(-4)}`
  await send(msg.chat.id, `🎁 **Спасибо за донат!**\n\n💸 ${senderName} пожертвовал **${amount}⭐**\n💚 Это поможет развитию бота!`)
  const admin = await db.user.findFirst({ where: { isAdmin: true } })
  if (admin) {
    await send(admin.tgId, `🎁 **Новый донат!**\nОт: ${senderName}\nСумма: ${amount}⭐`)
  }
}

async function handleAdminStats(msg: TgMessage, user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  await doAdminStats(msg.chat.id)
}

async function doAdminStats(chatId: number | string) {
  const [users, duels, activeDuels, txCount, pendingWithdrawals] = await Promise.all([
    db.user.count(),
    db.duel.count({ where: { status: 'finished' } }),
    db.duel.count({ where: { status: { in: ['waiting', 'accepted', 'paid', 'rolling'] } } }),
    db.transaction.count(),
    db.withdrawal.count({ where: { status: 'pending' } }),
  ])

  const commission = await db.duel.aggregate({
    where: { status: 'finished', winnerTgId: { not: null } },
    _sum: { commission: true },
  })

  // Сумма донатов
  const donations = await db.transaction.aggregate({
    where: { type: 'donate' },
    _sum: { amount: true },
  })
  const donationsCount = await db.transaction.count({ where: { type: 'donate' } })

  // Сумма пополнений (всего звёзд вошло)
  const totalDeposited = await db.transaction.aggregate({
    where: { type: 'deposit' },
    _sum: { amount: true },
  })

  // Сумма выводов
  const totalWithdrawn = await db.transaction.aggregate({
    where: { type: 'withdraw' },
    _sum: { amount: true },
  })

  const commissionTotal = commission._sum.commission ?? 0
  const donationsTotal = Math.abs(donations._sum.amount ?? 0)
  const totalRevenue = commissionTotal + donationsTotal

  // Feature #10: Weekly top for seasonal rewards
  const weekTop = await db.user.findMany({
    where: { duelsPlayed: { gt: 0 } },
    orderBy: { totalEarned: 'desc' },
    take: 5,
    select: { tgId: true, username: true, firstName: true, totalEarned: true },
  })

  await send(
    chatId,
    [
      `📊 **Статистика бота**`,
      '',
      `👥 Юзеров: ${users}`,
      `🎲 Дуэлей сыграно: ${duels}`,
      `⚡ Активных дуэлей: ${activeDuels}`,
      `💸 Транзакций: ${txCount}`,
      '',
      `💰 **Доход бота:**`,
      `   🎲 Комиссия: ${commissionTotal}⭐`,
      `   🎁 Донатов: ${donationsTotal}⭐ (${donationsCount} шт.)`,
      `   💎 **Итого доход: ${totalRevenue}⭐**`,
      '',
      `📤 Пополнено всего: ${totalDeposited._sum.amount ?? 0}⭐`,
      `📥 Выведено всего: ${Math.abs(totalWithdrawn._sum.amount ?? 0)}⭐`,
      `⏳ Ожидают вывода: ${pendingWithdrawals}`,
      '',
      '📊 **Топ недели:**',
      ...weekTop.slice(0, 3).map((u, i) => `${['🥇','🥈','🥉'][i]} @${u.username || u.firstName || u.tgId} — ${u.totalEarned}⭐`),
    ].join('\n')
  )
}

async function handleAdminBroadcastCallback(cq: TgCallbackQuery) {
  const from = cq.from!
  const user = await upsertUser(from)
  if (!user.isAdmin) {
    // callback already answered at top
    return
  }
  // callback already answered at top
  await send(
    cq.message?.chat.id ?? from.id,
    '📢 **Рассылка**\n\nИспользуйте команду:\n`/broadcast <текст>`\n\nПример: `/broadcast Скоро турнир!`'
  )
}

async function handleBroadcast(msg: TgMessage, user: { isAdmin: boolean }, text?: string) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  if (!text) {
    await send(msg.chat.id, '⚠️ `/broadcast <текст>`')
    return
  }
  const users = await db.user.findMany({ where: { isBanned: false }, select: { tgId: true } })
  let sent = 0
  let failed = 0
  for (const u of users) {
    try {
      await send(u.tgId, `📢 ${text}`)
      sent++
    } catch {
      failed++
    }
    if (sent % 20 === 0) await sleep(500)
  }
  await send(msg.chat.id, `✅ Рассылка завершена.\nОтправлено: ${sent}\nОшибок: ${failed}`)
}

/* ------------------------------------------------------------------ */
/* Admin: Ban / Give                                                   */
/* ------------------------------------------------------------------ */

async function handleBan(msg: TgMessage, user: { isAdmin: boolean }, usernameArg?: string) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  if (!usernameArg || !usernameArg.startsWith('@')) {
    await send(msg.chat.id, '⚠️ `/ban @username`')
    return
  }
  const username = usernameArg.slice(1).toLowerCase()

  const target = await db.user.findFirst({ where: { username: username } })
  if (!target) {
    await send(msg.chat.id, `⚠️ @${username} не найден.`)
    return
  }
  await db.user.update({ where: { id: target.id }, data: { isBanned: true } })
  await send(msg.chat.id, `🚫 @${username} забанен.`)
}

async function handleGive(msg: TgMessage, user: { isAdmin: boolean }, usernameArg?: string, amountArg?: string) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  if (!usernameArg || !usernameArg.startsWith('@')) {
    await send(msg.chat.id, '⚠️ `/give @username N`')
    return
  }
  const amount = parseAmount(amountArg)
  if (!amount || amount < 1) {
    await send(msg.chat.id, '⚠️ Неверная сумма.')
    return
  }
  const username = usernameArg.slice(1).toLowerCase()

  const target = await db.user.findFirst({ where: { username: username } })
  if (!target) {
    await send(msg.chat.id, `⚠️ @${username} не найден.`)
    return
  }
  await creditBalance(target.id, amount, 'admin_give', `Админ начислил ${amount}⭐`)
  const newBal = (await db.user.findUnique({ where: { id: target.id } }))?.balance ?? 0
  await send(msg.chat.id, `✅ @${username} +${amount}⭐. Баланс: ${newBal}⭐`)
  try {
    await send(target.tgId, `🎁 Админ начислил вам ${amount}⭐. Баланс: ${newBal}⭐`)
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Withdraw callback                                                   */
/* ------------------------------------------------------------------ */

async function handleWithdrawCallback(cq: TgCallbackQuery, amountStr: string) {
  const from = cq.from!
  // callback already answered at top

  const amount = Number(amountStr)
  const validWithdrawAmounts = [50, 100, 500, 1000]
  if (!validWithdrawAmounts.includes(amount)) {
    return
  }

  const user = await upsertUser(from)
  await processWithdrawal(user, amount, cq.message?.chat.id ?? from.id)
}

/* ------------------------------------------------------------------ */
/* Admin FC/Promo callback with amount                                 */
/* ------------------------------------------------------------------ */

// Handle admin_fc with amount and admin_promo with amount inline in the main handler.
// "admin_fc:50" → action="admin_fc", arg="50"
// "admin_promo:100" → action="admin_promo", arg="100"

// Note: handleAdminFcCallback and handleAdminPromoCallback already handle the
// no-arg case (showing preset buttons). Here we add the with-amount case
// directly in the main callback dispatcher so it doesn't need a separate export.

// The main handleCallbackQuery function above already dispatches based on action.
// We need to update it to handle "admin_fc:50" and "admin_promo:100" patterns.
// This is done by checking if arg is a number in the existing handlers.


/**
 * AltGram Bot API client for Stars Duels bot.
 * Telegram-compatible API at http://188.134.95.254:2610.
 * Does NOT support parse_mode — use `entities` array.
 */

const ALTGRAM_API_URL =
  process.env.ALTGRAM_API_URL || 'http://188.134.95.254:2610'
const BOT_TOKEN = process.env.BOT_TOKEN || ''

export type TgEntity = {
  type: string
  offset: number
  length: number
  url?: string
  user?: { id: number; first_name: string; is_bot: boolean }
}

export type TgInlineKeyboardButton = {
  text: string
  callback_data?: string
  url?: string
  web_app?: { url: string }
  copy_text?: { text: string }
  style?: 'primary' | 'danger' | 'success'
}

export type TgInlineKeyboardMarkup = {
  inline_keyboard: TgInlineKeyboardButton[][]
}

export interface TgResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
}

async function tgFetch<T>(method: string, body: Record<string, unknown>) {
  const url = `${ALTGRAM_API_URL}/bot${BOT_TOKEN}/${method}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as TgResponse<T>
  if (!data.ok) {
    console.error(
      `[altgram] ${method} failed:`,
      data.error_code,
      data.description,
      JSON.stringify(body).slice(0, 200)
    )
  }
  return data
}

/**
 * Convert **markdown-ish** markers to plain text + entities.
 * Supports: **bold**, *italic*, __underline__, ~~strike~~, `code`.
 */
export function md(text: string): { text: string; entities: TgEntity[] } {
  const entities: TgEntity[] = []
  const out: string[] = []
  let i = 0
  let pos = 0

  const rules: { re: RegExp; type: string }[] = [
    { re: /\*\*(.+?)\*\*/, type: 'bold' },
    { re: /__(.+?)__/, type: 'underline' },
    { re: /~~(.+?)~~/, type: 'strikethrough' },
    { re: /`([^`]+?)`/, type: 'code' },
    { re: /\*(.+?)\*/, type: 'italic' },
  ]

  while (i < text.length) {
    let matched = false
    for (const r of rules) {
      r.re.lastIndex = i
      const m = r.re.exec(text)
      if (m && m.index === i) {
        out.push(m[1])
        entities.push({ type: r.type, offset: pos, length: m[1].length })
        pos += m[1].length
        i += m[0].length
        matched = true
        break
      }
    }
    if (!matched) {
      out.push(text[i])
      pos++
      i++
    }
  }
  return { text: out.join(''), entities }
}

export const altgram = {
  api: ALTGRAM_API_URL,

  async getMe() {
    return tgFetch<{ id: number; is_bot: boolean; first_name: string; username: string }>('getMe', {})
  },

  async sendMessage(params: {
    chat_id: number | string
    text: string
    entities?: TgEntity[]
    reply_markup?: TgInlineKeyboardMarkup
    disable_web_page_preview?: boolean
    reply_to_message_id?: number
  }) {
    return tgFetch<{ message_id: number }>('sendMessage', params)
  },

  async editMessageText(params: {
    chat_id: number | string
    message_id: number
    text: string
    entities?: TgEntity[]
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    return tgFetch<{ message_id: number }>('editMessageText', params)
  },

  async answerCallbackQuery(params: {
    callback_query_id: string
    text?: string
    show_alert?: boolean
  }) {
    return tgFetch<boolean>('answerCallbackQuery', params)
  },

  async setMyCommands(commands: { command: string; description: string }[]) {
    return tgFetch<boolean>('setMyCommands', { commands })
  },

  async sendInvoice(params: {
    chat_id: number | string
    title: string
    description: string
    payload: string
    currency: 'XTR'
    prices: { label: string; amount: number }[]
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    return tgFetch<{ message_id: number }>('sendInvoice', params)
  },

  async sendGift(params: {
    user_id: number
    gift_id: string
    text?: string
    text_parse_mode?: string
  }) {
    // Если text не передан — отправляем без него (скрытно)
    const body: Record<string, unknown> = {
      user_id: params.user_id,
      gift_id: params.gift_id,
    }
    if (params.text) {
      body.text = params.text
    }
    return tgFetch<boolean>('sendGift', body)
  },

  async getAvailableGifts() {
    return tgFetch<{ count: number; gifts: Array<{ id: string; star_count: number; convert_star_count: number; sticker: { emoji: string; file_id: string }; remaining_count?: number }> }>('getAvailableGifts', {})
  },

  async deleteMessage(params: { chat_id: number | string; message_id: number }) {
    return tgFetch<boolean>('deleteMessage', params)
  },

  async getUpdates(params: {
    offset: number
    timeout: number
    allowed_updates?: string[]
  }) {
    return tgFetch<unknown[]>('getUpdates', params)
  },

  async deleteWebhook() {
    return tgFetch<boolean>('deleteWebhook', {})
  },

  async answerPreCheckoutQuery(params: {
    pre_checkout_query_id: string
    ok: boolean
    error_message?: string
  }) {
    return tgFetch<boolean>('answerPreCheckoutQuery', params)
  },
}

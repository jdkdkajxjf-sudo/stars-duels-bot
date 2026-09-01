/** Telegram types used by the duels bot. */

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  entities?: TgMessageEntity[]
  reply_to_message?: TgMessage
  successful_payment?: TgSuccessfulPayment
  web_app_data?: { data: string; button_text: string }
  dice?: { value: number; emoji: string }
}

export interface TgMessageEntity {
  type: string
  offset: number
  length: number
  url?: string
  user?: TgUser
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  inline_message_id?: string
  chat_instance?: string
  data?: string
  game_short_name?: string
}

export interface TgSuccessfulPayment {
  currency: string
  total_amount: number
  invoice_payload: string
  telegram_payment_charge_id?: string
  provider_payment_charge_id?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  callback_query?: TgCallbackQuery
  pre_checkout_query?: {
    id: string
    from: TgUser
    currency: string
    total_amount: number
    invoice_payload: string
  }
}

# Stars Duels Bot — Деплой на Render + Neon (бесплатно, без карты)

## Шаг 1: Создать БД на Neon.tech (1 минута)

1. Открой https://neon.tech
2. Нажми "Sign up" → Google/GitHub (без карты!)
3. Создай проект → получи connection string:
   ```
   postgresql://user:password@ep-xxx.region.aws.neon.tech/dbname?sslmode=require
   ```
4. **Сохрани этот URL** — он нужен для DATABASE_URL

## Шаг 2: Загрузить код на GitHub

1. Открой https://github.com/new
2. Создай репозиторий `stars-duels-bot` (private)
3. Загрузи файлы из ZIP (drag & drop):
   - Распакуй `duels-bot.zip`
   - Загрузи все файлы на GitHub

## Шаг 3: Деплой на Render.com (2 минуты)

1. Открой https://render.com → "Sign up" → GitHub (без карты!)
2. "New +" → "Web Service"
3. Подключи GitHub репозиторий `stars-duels-bot`
4. Настройки:
   - **Name:** stars-duels-bot
   - **Environment:** Docker
   - **Region:** Frankfurt
   - **Plan:** Free
5. Environment Variables:
   ```
   BOT_TOKEN=1780243657:e1oGVqbBVONGBiztoHaGkmlDowOlAToaNRZ
   ALTGRAM_API_URL=http://188.134.95.254:2610
   ADMIN_USERNAME=crash
   COMMISSION_RATE=0.10
   DATABASE_URL=postgresql://... (твой Neon URL из Шага 1)
   ```
6. Нажми "Create Web Service"
7. Жди 3-5 минут (сборка Docker)

## Шаг 4: Не давать боту уснуть (UptimeRobot)

Render free tier спит через 15 мин бездействия. Решение:

1. Открой https://uptimerobot.com → Sign up (бесплатно, без карты)
2. "Add New Monitor"
3. Настройки:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** Stars Duels Bot
   - **URL:** https://stars-duels-bot.onrender.com/health
   - **Monitoring Interval:** 5 minutes
4. "Create Monitor"

Теперь бот работает 24/7 — UptimeRobot пингает каждые 5 минут и не даёт Render уснуть.

## ✅ Готово!

Бот `@duelsbot` работает 24/7 на Render, БД на Neon, пинги на UptimeRobot.

## Проверка

- Health: https://stars-duels-bot.onrender.com/health → "OK: duels-bot running"
- Бот в Telegram: `@duelsbot` → `/start`

## Переменные окружения

| Variable | Value |
|---|---|
| BOT_TOKEN | 1780243657:e1oGVqbBVONGBiztoHaGkmlDowOlAToaNRZ |
| ALTGRAM_API_URL | http://188.134.95.254:2610 |
| ADMIN_USERNAME | crash |
| COMMISSION_RATE | 0.10 |
| DATABASE_URL | (из Neon.tech) |

## Команды бота

```
/duel 100              — публичная дуэль
/duel @user 100        — вызов юзера
/cancel                — отменить дуэль
/balance               — баланс + кнопки
/topup 100             — пополнить через Stars
/withdraw 50           — вывести через gift
/daily                 — ежедневный бонус
/ref                   — реферальная ссылка
/promo КОД             — активировать промокод
/stats                 — статистика
/top                   — лидерборд
/history               — последние дуэли

Админ (@crash):
/addfc 500             — Fast Click раздача
/addpromo 100          — создать промокод
/adminstats            — статистика бота
/ban @user             — забанить
/give @user N          — начислить звёзды
/broadcast текст       — рассылка
```

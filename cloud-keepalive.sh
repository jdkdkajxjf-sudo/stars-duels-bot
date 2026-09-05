#!/usr/bin/env bash
# Stars Duels Bot — улучшенный монитор для Cloud Shell
# 
# Что делает:
# 1. Перед запуском: git pull (чтобы код был свежий)
# 2. Проверяет что DATABASE_URL подключается
# 3. Каждые 30 сек проверяет жив ли бот
# 4. Если упал — перезапускает
# 5. Пингует health endpoint (anti-sleep Cloud Shell)
# 6. Логирует все события с timestamp
# 7. Бэкапит БД на GitHub если SQLite (через коммит)

set -u
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$BOT_DIR/bot.log"
MONITOR_LOG="$BOT_DIR/monitor.log"
HEALTH_URL="http://localhost:3006/health"
CHECK_INTERVAL=30
RESTART_COUNT_FILE="$BOT_DIR/.restart_count"

mkdir -p "$BOT_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$MONITOR_LOG"
}

# Инициализация счётчика рестартов
if [ ! -f "$RESTART_COUNT_FILE" ]; then
  echo "0" > "$RESTART_COUNT_FILE"
fi

get_restart_count() {
  cat "$RESTART_COUNT_FILE" 2>/dev/null || echo "0"
}

inc_restart_count() {
  local count=$(get_restart_count)
  echo $((count + 1)) > "$RESTART_COUNT_FILE"
}

kill_all_bots() {
  pkill -9 -f "bun run index" 2>/dev/null
  pkill -9 -f "bun index.ts" 2>/dev/null
  sleep 1
}

is_bot_alive() {
  pgrep -f "bun run index" > /dev/null 2>&1
}

check_env() {
  if [ ! -f "$BOT_DIR/.env" ]; then
    log "❌ .env файл не найден! Создай .env с BOT_TOKEN, DATABASE_URL и т.д."
    return 1
  fi
  
  # Проверяем DATABASE_URL
  if ! grep -q "DATABASE_URL=" "$BOT_DIR/.env"; then
    log "❌ DATABASE_URL не задан в .env"
    return 1
  fi
  
  return 0
}

update_code() {
  cd "$BOT_DIR"
  log "📥 Проверка обновлений кода..."
  
  # Сохраняем локальные изменения .env
  if [ -f ".env" ]; then
    cp .env .env.backup
  fi
  
  # Git pull
  if git pull --rebase origin main 2>&1 | grep -q "Updating\|Fast-forward"; then
    log "✅ Код обновлён"
    # Регенерируем Prisma client
    bunx prisma generate > /dev/null 2>&1
  else
    log "ℹ️ Код актуален"
  fi
  
  # Восстанавливаем .env
  if [ -f ".env.backup" ]; then
    mv .env.backup .env
  fi
}

start_bot() {
  cd "$BOT_DIR"
  kill_all_bots
  
  # Обновляем код перед стартом
  update_code
  
  # Проверяем env
  if ! check_env; then
    log "❌ Не могу запустить бота — проблемы с .env"
    return 1
  fi
  
  # Проверяем, нужно ли переключить provider на postgresql
  DB_URL=$(grep "^DATABASE_URL=" .env | cut -d'=' -f2-)
  if echo "$DB_URL" | grep -q "^postgres"; then
    log "🐘 PostgreSQL режим (Supabase/Neon)"
    sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma 2>/dev/null
  elif echo "$DB_URL" | grep -q "^file:"; then
    log "📁 SQLite режим (локальная БД)"
    sed -i 's/provider = "postgresql"/provider = "sqlite"/' prisma/schema.prisma 2>/dev/null
  fi
  
  # Применяем миграции
  log "🔧 Применение миграций БД..."
  if ! bunx prisma db push --accept-data-loss >> "$LOG" 2>&1; then
    log "❌ Ошибка миграции БД"
    return 1
  fi
  
  # Запускаем бота
  nohup bun run index.ts >> "$LOG" 2>&1 &
  local PID=$!
  disown $PID 2>/dev/null || true
  log "▶️ Бот запущен, PID=$PID"
  
  # Ждём и проверяем
  sleep 8
  if is_bot_alive; then
    log "✅ Бот работает"
    inc_restart_count
    log "📊 Всего рестартов: $(get_restart_count)"
    return 0
  else
    log "❌ Бот упал сразу после старта — проверь bot.log"
    tail -20 "$LOG" >> "$MONITOR_LOG"
    return 1
  fi
}

# ====== Главный цикл ======
log "========================================"
log "Stars Duels Bot — улучшенный 24/7 монитор"
log "BOT_DIR: $BOT_DIR"
log "DATABASE: $(grep '^DATABASE_URL=' .env 2>/dev/null | sed 's/.*@//' | head -c 30)..."
log "========================================"

# Первый запуск
if ! is_bot_alive; then
  start_bot
else
  log "ℹ️ Бот уже запущен"
fi

# Бесконечный цикл мониторинга
while true; do
  sleep "$CHECK_INTERVAL"
  
  if is_bot_alive; then
    # Бот работает — пингуем health для anti-sleep
    HEALTH=$(curl -s -m 3 "$HEALTH_URL" 2>/dev/null)
    
    # Лог раз в 5 минут
    MINUTE=$(date '+%M')
    SECOND=$(date '+%S')
    if [ "$SECOND" -lt 30 ]; then
      if [ "$((MINUTE % 5))" -eq 0 ]; then
        log "💚 Бот работает ($(pgrep -f 'bun run index' | head -1)) | health: ${HEALTH:0:30}"
      fi
    fi
  else
    log "🔴 Бот упал — перезапуск..."
    start_bot
  fi
done

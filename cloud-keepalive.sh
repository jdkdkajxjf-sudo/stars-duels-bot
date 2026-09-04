#!/usr/bin/env bash
# Stars Duels Bot — простой и надёжный 24/7 монитор для Cloud Shell
# - Запускает бота в фоне (nohup)
# - Каждые 30 сек проверяет жив ли процесс
# - Если упал — перезапускает
# - Пингует health чтобы Cloud Shell не засыпал
# - Убивает зомби-процессы перед запуском

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$BOT_DIR/bot.log"
MONITOR_LOG="$BOT_DIR/monitor.log"
HEALTH_URL="http://localhost:3006/health"
CHECK_INTERVAL=30

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$MONITOR_LOG"
}

kill_all_bots() {
  # Убиваем все bun-процессы кроме себя
  pkill -9 -f "bun run index" 2>/dev/null
  pkill -9 -f "bun index.ts" 2>/dev/null
  sleep 1
}

is_bot_alive() {
  pgrep -f "bun run index" > /dev/null 2>&1
}

start_bot() {
  cd "$BOT_DIR"
  # Очищаем старый PID
  kill_all_bots
  
  # Запускаем в фоне через nohup + disown
  nohup bun run index.ts >> "$LOG" 2>&1 &
  local PID=$!
  disown $PID 2>/dev/null || true
  log "▶️ Бот запущен, PID=$PID"
  
  # Ждём 8 сек и проверяем что он не упал сразу
  sleep 8
  if is_bot_alive; then
    log "✅ Бот работает"
    return 0
  else
    log "❌ Бот упал сразу после старта"
    return 1
  fi
}

# ====== Главный цикл ======
log "========================================"
log "Stars Duels Bot — 24/7 монитор запущен"
log "BOT_DIR: $BOT_DIR"
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
    # Бот работает — пингуем health для anti-sleep Cloud Shell
    curl -s -m 3 "$HEALTH_URL" > /dev/null 2>&1
    # Тихий лог раз в 5 минут (10 циклов по 30 сек)
    MINUTE=$(date '+%M')
    if [ "$((MINUTE % 5))" = "0" ]; then
      log "💚 Бот работает ($(pgrep -f 'bun run index' | head -1))"
    fi
  else
    log "🔴 Бот упал — перезапуск..."
    start_bot
  fi
done

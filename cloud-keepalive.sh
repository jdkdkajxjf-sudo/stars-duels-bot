#!/usr/bin/env bash
# Stars Duels Bot — умный мониторинг для Cloud Shell
# - Запускает бота в фоне (nohup)
# - Каждые 60 сек проверяет жив ли бот
# - Если упал (краш AltGram, OOM, и т.д.) — перезапускает
# - Не трогает бот если он работает нормально
# - Пингует health endpoint чтобы Cloud Shell не засыпал

set -u
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$BOT_DIR/bot.log"
MONITOR_LOG="$BOT_DIR/monitor.log"
PID_FILE="$BOT_DIR/bot.pid"
CHECK_INTERVAL=60  # проверка каждые 60 сек
HEALTH_URL="http://localhost:3006/health"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$MONITOR_LOG"
}

start_bot() {
  cd "$BOT_DIR"
  # Убиваем старый процесс если есть
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      kill -9 "$OLD_PID" 2>/dev/null
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi

  # Запускаем в фоне
  nohup bun run index.ts >> "$LOG" 2>&1 &
  BOT_PID=$!
  echo "$BOT_PID" > "$PID_FILE"
  log "✓ Бот запущен, PID=$BOT_PID"
}

check_bot_alive() {
  # Проверяем жив ли процесс
  if [ ! -f "$PID_FILE" ]; then
    log "✗ PID файл не найден — бот не запущен"
    return 1
  fi

  BOT_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -z "$BOT_PID" ]; then
    log "✗ PID пустой"
    return 1
  fi

  if ! kill -0 "$BOT_PID" 2>/dev/null; then
    log "✗ Процесс $BOT_PID мёртв"
    return 1
  fi

  # Пингуем health endpoint
  HEALTH_RESP=$(curl -s -m 5 "$HEALTH_URL" 2>/dev/null)
  if [ -z "$HEALTH_RESP" ]; then
    log "⚠️ Health не отвечает, но процесс жив — возможно AltGram лагает"
    # Не убиваем — даём ему шанс восстановиться (ConnectionRefused → 15s wait в коде)
    return 0
  fi

  return 0
}

# Главный цикл
log "=== Запуск монитора Stars Duels Bot ==="
log "BOT_DIR=$BOT_DIR"
log "CHECK_INTERVAL=${CHECK_INTERVAL}s"

# Первый запуск
if ! check_bot_alive; then
  start_bot
  sleep 5
fi

# Бесконечный цикл проверки
while true; do
  sleep "$CHECK_INTERVAL"

  if check_bot_alive; then
    # Бот работает — пингуем health для anti-sleep
    curl -s -m 3 "$HEALTH_URL" > /dev/null 2>&1
  else
    log "🔄 Бот упал — перезапуск..."
    start_bot
    sleep 5

    # Проверяем что запуск успешен
    if check_bot_alive; then
      log "✅ Бот успешно перезапущен"
    else
      log "❌ Не удалось запустить — пробуем ещё раз через 30 сек"
      sleep 30
      start_bot
    fi
  fi
done

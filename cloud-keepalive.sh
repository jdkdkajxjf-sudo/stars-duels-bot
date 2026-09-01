#!/usr/bin/env bash
# Stars Duels Bot — Cloud Shell keepalive
# Запускает бота и перезапускает каждые 15 минут

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$BOT_DIR/bot.log"
RESTART_INTERVAL=900  # 15 минут

while true; do
  echo "[$(date)] Starting bot..."
  cd "$BOT_DIR"
  bun index.ts >> "$LOG" 2>&1 &
  BOT_PID=$!
  echo "[$(date)] Bot started, PID=$BOT_PID"

  # Ждём 15 минут
  sleep $RESTART_INTERVAL

  # Проверяем жив ли бот
  if kill -0 $BOT_PID 2>/dev/null; then
    echo "[$(date)] 15 min passed, restarting bot (PID=$BOT_PID)..."
    kill $BOT_PID 2>/dev/null
    sleep 2
    # Если не убился — force kill
    kill -9 $BOT_PID 2>/dev/null
    sleep 1
  else
    echo "[$(date)] Bot already dead, restarting..."
  fi
done

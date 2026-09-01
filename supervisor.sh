#!/usr/bin/env bash
# Stars Duels Bot — persistent supervisor
# Restarts bot every time it dies

ROOT="/home/z/my-project/mini-services/duels-bot"
LOG="$ROOT/bot.log"

while true; do
  echo "[$(date)] Starting bot..."
  cd "$ROOT"
  exec bun index.ts >> "$LOG" 2>&1
  echo "[$(date)] Bot exited with code $?, restarting in 3s..."
  sleep 3
done

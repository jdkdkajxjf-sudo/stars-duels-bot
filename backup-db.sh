#!/usr/bin/env bash
# backup-db.sh — бэкап SQLite БД на GitHub
# Запускать через cron на Cloud Shell: каждый час

set -u
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$BOT_DIR"

echo "[$(date '+%H:%M:%S')] === Бэкап БД ==="

# Бэкап только если SQLite
DB_URL=$(grep "^DATABASE_URL=" .env 2>/dev/null | cut -d'=' -f2-)
if ! echo "$DB_URL" | grep -q "^file:"; then
  echo "[$(date '+%H:%M:%S')] БД не SQLite (используется PostgreSQL) — бэкап не нужен"
  exit 0
fi

# Бэкап SQLite
if [ -f "duels.db" ]; then
  # Копируем БД в backups/
  mkdir -p backups
  TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
  cp duels.db "backups/duels_${TIMESTAMP}.db"
  
  # Держим только последние 24 часа (24 бэкапа)
  ls -t backups/duels_*.db 2>/dev/null | tail -n +25 | xargs -r rm
  echo "[$(date '+%H:%M:%S')] Создан бэкап: backups/duels_${TIMESTAMP}.db"
fi

echo "[$(date '+%H:%M:%S')] === Бэкап завершён ==="

#!/usr/bin/env bash
# Stars Duels Bot — keepalive + maintenance
# Runs every 5 min via cron

cd /home/z/my-project/mini-services/duels-bot

# 1. Check if bot is alive
if curl -s --max-time 3 http://localhost:3006/health | grep -q "OK"; then
  echo "[$(date)] Bot is alive"
else
  echo "[$(date)] Bot is dead, restarting..."
  pkill -f "duels-bot/index.ts" 2>/dev/null
  sleep 1
  rm -f .offset.json
  nohup bun index.ts >> bot.log 2>&1 &
  disown
  sleep 5
  if curl -s --max-time 3 http://localhost:3006/health | grep -q "OK"; then
    echo "[$(date)] Bot restarted successfully"
  else
    echo "[$(date)] Bot failed to start"
  fi
fi

# 2. Feature #16: Auto-cancel old pending duels (>1 hour)
bun -e "
import { db } from './src/db'
const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
const old = await db.duel.findMany({
  where: { status: { in: ['waiting', 'accepted'] }, createdAt: { lt: hourAgo } },
  select: { id: true },
})
if (old.length > 0) {
  await db.duel.updateMany({ where: { id: { in: old.map(d => d.id) } }, data: { status: 'timed_out' } })
  console.log('[' + new Date().toISOString() + '] Auto-cancelled ' + old.length + ' old duels')
}
await db.\$disconnect()
" 2>/dev/null

# 3. Feature #19: Daily backup (once per day)
TODAY=$(date +%Y%m%d)
BACKUP_DIR="/home/z/my-project/db/backups"
if [ ! -f "$BACKUP_DIR/duels-$TODAY.db" ]; then
  mkdir -p "$BACKUP_DIR" 2>/dev/null
  cp /home/z/my-project/db/duels.db "$BACKUP_DIR/duels-$TODAY.db" 2>/dev/null
  echo "[$(date)] Daily backup created: duels-$TODAY.db"
  # Keep only last 7 days
  find "$BACKUP_DIR" -name "duels-*.db" -mtime +7 -delete 2>/dev/null
fi

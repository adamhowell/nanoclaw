#!/usr/bin/env bash
LOG="$HOME/nanoclaw/logs/handoff_sync.log"
[ ! -f "$LOG" ] && exit 0
SIZE=$(stat -f%z "$LOG" 2>/dev/null || stat -c%s "$LOG")
if [ "$SIZE" -gt 5242880 ]; then
  mv "$LOG" "$LOG.old"
  : > "$LOG"
fi

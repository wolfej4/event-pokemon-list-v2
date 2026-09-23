#!/bin/sh
# Starts as root just long enough to make sure the data folder belongs to the
# app user (volumes created by older images or root-owned bind mounts won't),
# then drops to the unprivileged "node" user to run the app.
set -e
DATA_DIR="${DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ -n "$(find "$DATA_DIR" \( ! -user node -o ! -group node \) -print -quit 2>/dev/null)" ]; then
    echo "[entrypoint] fixing ownership of $DATA_DIR"
    chown -R node:node "$DATA_DIR" || echo "[entrypoint] WARNING: couldn't change ownership of $DATA_DIR (read-only or NFS mount?)"
  fi
  exec su-exec node "$@"
fi
exec "$@"

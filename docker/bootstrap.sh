#!/bin/sh
# Entrypoint of the n8n container in docker-compose.yml.
# First start only: import and publish the case workflows (a few minutes).
# Later starts leave your edits alone.
set -eu

MARK=/home/node/.n8n/.exprlab-imported

if [ ! -f "$MARK" ]; then
  STAGE=$(mktemp -d)
  node /bootstrap/prepare.mjs "$STAGE" /bootstrap/workflows
  n8n import:workflow --separate --input="$STAGE"
  # One CLI call per workflow; this is most of the first start.
  for file in "$STAGE"/*.json; do
    n8n publish:workflow --id="$(basename "$file" .json)"
  done
  rm -rf "$STAGE"
  touch "$MARK"
  echo "exprlab: workflows imported and published"
fi

exec n8n start

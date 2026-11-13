#!/bin/sh
# test/stack.sh up|down|logs   the test stack by hand
cd "$(dirname "$0")/.."
action=$1
files="-f docker-compose.yml -f test/docker-compose.yml"
case "$action" in
  up) docker compose --env-file test/test.env $files -p exprlab-test up -d ;;
  down) docker compose --env-file test/test.env $files -p exprlab-test down -v ;;
  logs) docker compose --env-file test/test.env $files -p exprlab-test logs --tail "${TAIL:-40}" n8n ;;
esac

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
source hostgator-setup-kit/_common.sh
enter_project

EXPECTED_VERSION=""
if [ "${1:-}" = "--expect-version" ]; then
  EXPECTED_VERSION="${2:-}"
  [ -n "$EXPECTED_VERSION" ] || { echo "erro: versão esperada ausente" >&2; exit 2; }
fi

dc config --quiet
dc ps

HEALTH_BODY="$(wait_app_healthy 20 3)" || {
  echo "erro: app não atingiu estado healthy/degraded" >&2
  printf '%s\n' "$HEALTH_BODY" >&2
  exit 1
}

if [ -n "$EXPECTED_VERSION" ] && ! printf '%s' "$HEALTH_BODY" | grep -Fq "\"version\":\"$EXPECTED_VERSION\""; then
  echo "erro: imagem não reporta a versão esperada $EXPECTED_VERSION" >&2
  exit 1
fi

dc exec -T worker sh -eu -c '
  test "$FOODSERVICE_SALES_FAST_PATH" = true
  test "$AGENT_FAST_CONTEXT_PROFILE" = true
  test "$STAGE_CLASSIFIER_FAST_LANE" = true
  test "$INBOUND_DEBOUNCE_MS" = 0
  test "$CRM_DRAIN_INTERVAL_MS" = 500
  test "$CRM_DRAIN_IDLE_INTERVAL_MS" = 1000
  test "$QUEUE_POLL_INTERVAL_MS" = 250
  test "$QUEUE_IDLE_POLL_MAX_INTERVAL_MS" = 1000
'

WORKER_ID="$(dc ps -q worker)"
[ -n "$WORKER_ID" ] || { echo "erro: worker não encontrado" >&2; exit 1; }
WORKER_HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$WORKER_ID")"
[ "$WORKER_HEALTH" = "healthy" ] || { echo "erro: worker $WORKER_HEALTH" >&2; exit 1; }

echo "healthcheck ok${EXPECTED_VERSION:+ — versão $EXPECTED_VERSION}"

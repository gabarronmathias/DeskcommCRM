#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
source hostgator-setup-kit/_common.sh
enter_project

TENANT_ID=""
INBOUND_ID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tenant-id) shift; TENANT_ID="${1:-}" ;;
    --inbound-message-id) shift; INBOUND_ID="${1:-}" ;;
    *) echo "uso: bash scripts/production/smoke-test.sh --tenant-id UUID --inbound-message-id UUID" >&2; exit 2 ;;
  esac
  shift
done

UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
[[ "$TENANT_ID" =~ $UUID_RE ]] || { echo "erro: --tenant-id inválido" >&2; exit 2; }
[[ "$INBOUND_ID" =~ $UUID_RE ]] || { echo "erro: --inbound-message-id inválido" >&2; exit 2; }

bash scripts/production/healthcheck.sh

COUNTS="$(psql_run -At -v tenant_id="$TENANT_ID" -v inbound_id="$INBOUND_ID" <<'SQL'
with owner_jobs as (
  select id
  from job_queue
  where organization_id = :'tenant_id'::uuid
    and payload->>'inbound_message_id' = :'inbound_id'
), response_ledgers as (
  select distinct sl.id
  from send_ledger sl
  join owner_jobs j on j.id = sl.job_id
  where sl.organization_id = :'tenant_id'::uuid
    and sl.status in ('accepted', 'queued')
)
select
  (select count(*) from messages
    where organization_id = :'tenant_id'::uuid
      and id = :'inbound_id'::uuid
      and direction = 'inbound') || '|' ||
  (select count(*) from response_ledgers) || '|' ||
  (select count(distinct m.id)
    from messages m
    join response_ledgers r on m.metadata->>'idempotency_key' = r.id::text
    where m.organization_id = :'tenant_id'::uuid);
SQL
)"

IFS='|' read -r INBOUND_COUNT LEDGER_COUNT OUTBOUND_COUNT <<EOF
$COUNTS
EOF

[ "$INBOUND_COUNT" = "1" ] || { echo "smoke falhou: inbound_count=$INBOUND_COUNT" >&2; exit 1; }
[ "$LEDGER_COUNT" = "1" ] || { echo "smoke falhou: response_ledger_count=$LEDGER_COUNT" >&2; exit 1; }
[ "$OUTBOUND_COUNT" = "1" ] || { echo "smoke falhou: outbound_count=$OUTBOUND_COUNT" >&2; exit 1; }

echo "smoke ok: inbound=1 response_ledger=1 outbound=1"

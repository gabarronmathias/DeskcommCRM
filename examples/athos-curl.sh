#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Exemplo de request que o time Athos envia pro G&M CRM.
# ----------------------------------------------------------------------------
# Substitua ATHOS_TOKEN pelo token entregue pela G&M (formato
# `dsk_<8-hex-prefix>_<32-byte-random-base64url>`) e CUSTOMER_PHONE pelo
# telefone E.164 do cliente que você quer consultar.
#
# O token é lido da env ATHOS_TOKEN pra não vazar no histórico do shell:
#   ATHOS_TOKEN="dsk_aabbccdd_..." CUSTOMER_PHONE="+5511999998888" ./examples/athos-curl.sh
#
# Esse arquivo é entregue como template — o time Athos pode usar curl,
# fetch em Node, requests em Python, ou qualquer cliente HTTP. O contrato
# está em docs/integracoes/athos-order-history.md.
# ----------------------------------------------------------------------------
set -euo pipefail

: "${ATHOS_TOKEN:?ATHOS_TOKEN não definida — exporte o token entregue pela G&M}"
: "${CUSTOMER_PHONE:=+5511999998888}"

BASE_URL="${BASE_URL:-https://crm.gabarronmathias.com}"
LIMIT="${LIMIT:-50}"
STATUS="${STATUS:-completed}"   # pseudo-status: só pedidos pagos/entregues

curl -sS \
  -H "Authorization: Bearer ${ATHOS_TOKEN}" \
  -H "Accept: application/json" \
  -w "\n---\nstatus: %{http_code}\nx-request-id: %header{x-request-id}\n" \
  "${BASE_URL}/api/v1/customers/$(printf '%s' "${CUSTOMER_PHONE}" | sed 's/+/%2B/g')/order-history?limit=${LIMIT}&status=${STATUS}"

# Integração Athos — Histórico de Vendas por Cliente

API REST server-to-server que devolve o histórico de compras de um cliente
específico do seu tenant — base para campanhas de recompra e reativação.

**Base URL (produção):** `https://crm.gabarronmathias.com`
**Endpoint:** `GET /api/v1/customers/{phone}/order-history`

---

## 1. Autenticação

Todas as requisições exigem header `Authorization: Bearer <api_token>`.

O token é gerado uma vez pelo admin da plataforma via
`scripts/generate-athos-token.ts` e entregue ao time Athos **em texto
puro, uma única vez** (a tabela `api_tokens` guarda apenas o hash SHA256).
Guarde-o em local seguro (vault / secret manager). Quem rodar precisa ser
o dono da plataforma.

```http
GET /api/v1/customers/+5511999998888/order-history HTTP/1.1
Host: crm.gabarronmathias.com
Authorization: Bearer dsk_aabbccdd_<32-byte-random-base64url>
```

---

## 2. Contrato

### Path param

| Campo   | Tipo   | Obrigatório | Descrição                                                       |
| ------- | ------ | ----------- | --------------------------------------------------------------- |
| `phone` | string | sim         | Telefone do cliente. Aceita formatos comuns com ou sem `+55`. A API normaliza para E.164. |

### Query params (todos opcionais)

| Campo    | Tipo    | Default | Descrição                                                                          |
| -------- | ------- | ------- | ---------------------------------------------------------------------------------- |
| `from`   | ISO-8601| —       | Pedidos a partir de (inclusivo). Ex.: `2026-01-01T00:00:00Z`                       |
| `to`     | ISO-8601| —       | Pedidos até (exclusivo). Janela semiaberta `[from, to)`.                           |
| `status` | string  | —       | Filtro de status. Valores canônicos: `pending`, `paid`, `cancelled`, `fulfilled`, `shipped`, `delivered`, `refunded`. Pseudo-status: `not_cancelled` (exclui cancelados e estornados), `completed` (= `paid`+`fulfilled`+`shipped`+`delivered`). |
| `limit`  | int 1-200 | 50    | Tamanho da página.                                                                   |
| `cursor` | string  | —       | Cursor opaco retornado por chamada anterior. Próxima página.                         |

### Resposta (200 OK)

```json
{
  "data": {
    "customer_found": true,
    "query_phone_e164": "+5511999998888",
    "customer": {
      "id": "cccccccc-3333-4000-8000-000000000001",
      "name": "Maria Silva",
      "display_name": "Maria",
      "phone_number": "+5511999998888",
      "is_blocked": false,
      "is_anonymized": false,
      "tags": ["vip"],
      "last_activity_at": "2026-09-10T14:30:00Z"
    },
    "summary": {
      "total_orders": 12,
      "total_spent_cents": 48000,
      "avg_ticket_cents": 4000,
      "currency": "BRL",
      "first_order_at": "2025-09-01T00:00:00Z",
      "last_order_at": "2026-09-09T20:15:00Z",
      "days_since_last_order": 2,
      "favorite_products": [
        { "product_name": "Pizza Margherita", "quantity": 6, "order_count": 4 },
        { "product_name": "Hambúrguer Artesanal", "quantity": 3, "order_count": 3 }
      ]
    },
    "orders": [
      {
        "id": "00000000-0000-4000-8000-0000000000b1",
        "external_id": "ext-001",
        "external_provider": "gm_crm_food",
        "status": "delivered",
        "total_cents": 4500,
        "currency": "BRL",
        "payment_method": "pix",
        "fulfillment_status": "delivered",
        "tracking_code": null,
        "ordered_at": "2026-09-09T20:15:00Z",
        "is_anonymized": false,
        "items": [
          {
            "id": "00000000-0000-4000-8000-0000000000c1",
            "product_id": "00000000-0000-4000-8000-0000000000d1",
            "product_name_snapshot": "Pizza Margherita",
            "unit_price_cents": 4500,
            "quantity": 1,
            "line_total_cents": 4500,
            "selected_modifiers": [],
            "added_via_recommendation": false
          }
        ]
      }
    ]
  },
  "meta": {
    "cursor": "MjAyNi0wOS0wOVQyMDoxNTowMFp8MDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDBiMQ==",
    "has_more": true
  }
}
```

### Quando o cliente não existe (cold-lead)

`customer_found: false`, `customer: null`, `summary` zerado e `orders: []`.
Útil pra campanhas de aquisição — o telefone é válido (normalizou) mas
nunca comprou.

### Erros

| Status | `code`                  | Quando                                                                                          |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------------- |
| 401    | `unauthenticated`       | Sem header `Authorization`, malformado, token expirado ou revogado.                             |
| 403    | `forbidden_scope`       | Token válido mas sem scope `orders:read`. Pedir novo token com o scope certo.                    |
| 422    | `validation_failed`     | Telefone com formato impossível (3 dígitos etc.) ou query params inválidos.                      |
| 500    | `internal_error`        | Banco caiu, timeout. Retry com backoff exponencial.                                              |

Toda resposta (sucesso ou erro) carrega `X-Request-Id` no header — guarde
esse valor pra reportar incidente: ele correlaciona com o log de auditoria.

---

## 3. Idempotência e consistência

A API é **read-only**. Nenhuma mutação, nenhum side effect no banco do
tenant além do registro em `api_audit_log` (action `orders.read.history`)
com `actor_api_token_id` e filtros aplicados — útil pra auditoria LGPD.

Paginação é por cursor opaco (base64 de `(ordered_at, id)`). Não invente
o cursor — sempre use o `meta.cursor` retornado pela resposta anterior.
A ordem é DESC (mais recente primeiro).

---

## 4. Rate limit

100 req/s por organização (configurável em `organizations.rate_limit_rps`).
Em caso de pico, retorno `429 Too Many Requests` com `Retry-After`.

---

## 5. Exemplo end-to-end

```bash
curl -sS \
  -H "Authorization: Bearer dsk_aabbccdd_<secret>" \
  "https://crm.gabarronmathias.com/api/v1/customers/+5511999998888/order-history?limit=10&status=completed"
```

Resposta:

```json
{
  "data": {
    "customer_found": true,
    "summary": {
      "total_orders": 3,
      "total_spent_cents": 12000,
      "avg_ticket_cents": 4000,
      "days_since_last_order": 0,
      "favorite_products": [
        { "product_name": "Pizza Margherita", "quantity": 3, "order_count": 3 }
      ]
    },
    "orders": []
  },
  "meta": { "cursor": null, "has_more": false }
}
```

Script Node (cliente):

```js
const token = process.env.ATHOS_TOKEN;
const baseUrl = "https://crm.gabarronmathias.com";

async function getHistory(phone, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(
    `${baseUrl}/api/v1/customers/${encodeURIComponent(phone)}/order-history${qs ? "?" + qs : ""}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`${res.status} ${err.error?.code ?? "?"} — ${err.error?.message ?? res.statusText}`);
  }
  return await res.json();
}

const { data, meta } = await getHistory("+5511999998888", { limit: 50 });
console.log(`${data.customer.display_name}: ${data.summary.total_orders} pedidos, último há ${data.summary.days_since_last_order}d`);
```

---

## 6. Revogação do token

Ao final do contrato / suspeita de vazamento, revogue pelo painel admin
do CRM (`Configurações › API Tokens`) ou peça à equipe da G&M pra revogar.
A revogação seta `revoked_at` — chamadas subsequentes recebem 401 imediato.

---

## 7. Contato

Mudanças no contrato: avisar com 7 dias de antecedência via canal combinado
(hoje Slack `#gmcrm-integracoes`). Mudanças compatíveis (novo campo em
`summary`/`orders`, novo `status`) entram sem aviso, mas a doc é
versionada aqui.

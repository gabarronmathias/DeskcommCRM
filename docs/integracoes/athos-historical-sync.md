# Integração Athos — Sincronização de Histórico de Vendas

O endpoint por telefone (`/api/v1/customers/[phone]/order-history`) e a
auditoria por recência (`/api/v1/customers/purchase-recency`) consultam a
tabela `orders` + `food_order_items` do CRM. Para a Sarah montar campanhas
reais, **o histórico Athos precisa estar materializado nessas tabelas** — não
dá pra fazer N consultas à Athos por telefone em tempo de campanha.

Este documento define o contrato que a G&M precisa do time Athos para
popular o banco, sem criar tabela paralela.

---

## TL;DR — O status hoje (set/2026)

- A tabela `orders` já aceita `external_provider = 'athos'` (CHECK constraint
  expandido fora do repo em produção). Há 1 pedido stub no banco de produção.
- **Não existe** import/backfill de histórico Athos implementado no repo.
- **Não existe** webhook incremental.
- **Não existe** script de ingestão.

Sem histórico real sincronizado, `crm_list_customers_by_purchase_recency`
retorna audiência baseada apenas nos pedidos já no CRM (food commerce e
Nuvemshop). Para campanhas Athos reais, a integração abaixo é
**pré-requisito** (PARTE 5 do briefing: "ATHOS_CAMPAIGN_DATA_READY=SIM
somente se existir caminho comprovado para popular CRM com histórico real
Athos").

**ATHOS_CAMPAIGN_DATA_READY = NAO** até essa frente ser entregue.

---

## Modelo de dados (já existe no CRM)

`orders` e `food_order_items` já modelam tudo o que precisamos. Cada pedido
Athos é 1 linha em `orders` + N linhas em `food_order_items`.

### `orders` (campos relevantes)

| Coluna                 | Tipo        | Comentário                                                                                  |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `organization_id`      | uuid        | Tenant (filtro multi-tenant)                                                                |
| `external_id`          | text        | ID do pedido no sistema Athos — UNIQUE por `(org, external_provider, external_id)`          |
| `external_provider`    | text        | `'athos'` para esses pedidos                                                                |
| `customer_external_id` | text        | ID do cliente no sistema Athos (pra match/reconciliação). Nullable se Athos não expõe        |
| `contact_id`           | uuid        | FK `contacts.id`. O CRM precisa resolver o cliente Athos → contato CRM                       |
| `status`               | text        | `'pending' \| 'paid' \| 'cancelled' \| 'fulfilled' \| 'shipped' \| 'delivered' \| 'refunded'` |
| `total_cents`          | bigint      | Total do pedido em centavos. Mesma moeda (BRL)                                               |
| `currency`             | text        | `'BRL'` por default                                                                          |
| `payment_method`       | text        | Quando disponível                                                                            |
| `fulfillment_status`   | text        | Quando disponível. CHECK aceita: `'unpacked' \| 'packed' \| 'shipped' \| 'delivered'`        |
| `ordered_at`           | timestamptz | Quando o pedido foi feito                                                                    |
| `created_at`           | timestamptz | Quando entrou no CRM (default now())                                                         |

### `food_order_items`

| Coluna                  | Tipo        | Comentário                                                              |
| ----------------------- | ----------- | ----------------------------------------------------------------------- |
| `organization_id`       | uuid        | Tenant                                                                  |
| `order_id`              | uuid        | FK `orders.id`                                                          |
| `product_id`            | uuid        | FK opcional `food_products.id` — usar NULL quando Athos não expõe        |
| `product_name_snapshot` | text        | Nome do produto como aparecia no pedido Athos (imutável)                |
| `unit_price_cents`      | bigint      | Preço unitário em centavos                                               |
| `quantity`              | int         | Quantidade                                                              |
| `line_total_cents`      | bigint      | `unit_price_cents * quantity`                                            |
| `selected_modifiers`    | jsonb       | Modificadores/opções (default `'[]'`)                                   |
| `created_at`            | timestamptz | Default `now()`                                                          |

### `contacts` (match cliente)

Cliente Athos pode ser localizado por:
- `phone_number` (E.164 normalizado via `fn_food_normalize_phone`) — **fonte primária**
- `customer_external_id` (armazenado em `orders.customer_external_id` para auditoria)
- `metadata.athos_customer_id` em jsonb `contacts.source_metadata` (resolver manual)

---

## Contrato de ingestão — o que a G&M precisa do Athos

### Endpoint 1 — Backfill inicial (batch histórico)

`POST /v1/orders/backfill` (endpoint a ser implementado no CRM, autenticado
via api_token com novo scope `orders:write.athos`).

**Input** (body JSON):

```json
{
  "establishment_external_id": "athos-store-7",
  "since": "2024-01-01T00:00:00Z",
  "until": "2026-09-01T00:00:00Z",
  "page_size": 100,
  "page": 1
}
```

**Output** (pedidos + itens, ordem cronológica ASC por `ordered_at`):

```json
{
  "orders": [
    {
      "external_id": "athos-order-12345",
      "customer": {
        "external_id": "athos-cust-987",
        "name": "Maria Silva",
        "phone": "+5511999998888",
        "email": null
      },
      "ordered_at": "2025-09-15T20:30:00-03:00",
      "status": "delivered",
      "total_cents": 5500,
      "currency": "BRL",
      "payment_method": "pix",
      "fulfillment_status": "delivered",
      "items": [
        {
          "external_product_id": "athos-prod-12",
          "product_name": "Pizza Margherita G",
          "unit_price_cents": 3500,
          "quantity": 1,
          "line_total_cents": 3500,
          "modifiers": [
            { "name": "Borda catupiry", "price_cents": 800 }
          ]
        },
        {
          "external_product_id": "athos-prod-7",
          "product_name": "Coca-Cola 2L",
          "unit_price_cents": 2000,
          "quantity": 1,
          "line_total_cents": 2000,
          "modifiers": []
        }
      ]
    }
  ],
  "next_page": 2,
  "has_more": true
}
```

### Endpoint 2 — Incremental (webhook de novos pedidos)

`POST /webhooks/athos/orders` no CRM (autenticado via HMAC SHA512 sobre
`X-Athos-Signature`, segredo por estabelecimento).

**Input** (pedido único):

```json
{
  "event": "order.created" | "order.updated" | "order.cancelled" | "order.refunded",
  "occurred_at": "2026-09-13T10:00:00Z",
  "establishment_external_id": "athos-store-7",
  "order": { ... mesmo shape do backfill ... }
}
```

**Output**: `200 OK` (aceito e idempotente) ou `422` (payload inválido).

---

## Idempotência (PARTE 9 I/J do briefing)

A UNIQUE constraint `(organization_id, external_provider, external_id)` em
`orders` (já existe) garante:
- Importar o mesmo pedido 5 vezes → 1 linha em `orders`, N linhas em
  `food_order_items` (delete + insert dentro de transação, ou `ON CONFLICT
  DO NOTHING`).
- Atualizar o status de um pedido existente → UPDATE (não duplica).

LGPD: se um pedido foi anonimizado por LGPD no Athos, o webhook envia
`event=order.anonymized` e o CRM marca `is_anonymized=true` na `orders`.
Não vaza mais nome do cliente.

---

## LGPD (PARTE 7 do briefing)

- Sincronização precisa respeitar opt-out: se o cliente Athos tem
  `marketing_opt_out=true`, o CRM NÃO vai popular `consent.marketing`
  (deixa null → fora de campanhas).
- Sincronização precisa respeitar anonimização: pedidos antigos de clientes
  anonimizados podem vir com `customer.name = "[ANONIMIZADO]"` e o CRM
  filtra/bloqueia.
- Timezone explícito: o `ordered_at` sempre com offset (`-03:00` no caso
  do Brasil). Nunca naive datetime.

---

## Isolamento de tenant (PARTE 7 do briefing)

Cada tenant do CRM tem 1 (ou mais) estabelecimentos Athos associados.
O webhook recebe `establishment_external_id` e o CRM resolve para o
`organization_id` correto via tabela de mapping (não documentada aqui).
Se o mapping não existe → 401/403 (não vaza pra outra org).

---

## Performance (PARTE 8 do briefing)

- Backfill: 1 ordem por `external_id` (UNIQUE constraint). Index
  `orders_org_ordered_idx (organization_id, ordered_at DESC)` já existe e
  cobre o filtro de janela de tempo do backfill.
- Webhook incremental: 1 INSERT ou UPDATE por evento. Latência alvo < 200ms.
- Campanhas (`fn_customers_by_purchase_recency`) reusa o mesmo índice.

---

## Open questions para o time Athos

1. **Match de cliente**: Athos expõe `customer.external_id`? Ou só telefone?
   Se só telefone, qual a precisão? Cliente pode ter trocado de número?
2. **Modificadores**: estrutura exata do `modifiers` (name + price é o
   esperado, mas pode ter variantes como grupo obrigatório/opcional).
3. **Status mapping**: Athos usa os mesmos 7 status? Tem algum status
   próprio (ex.: `'awaiting_pickup'`) que precisa mapear?
4. **Webhook secret rotation**: como o Athos rotaciona o HMAC secret? Bearer
   com refresh? Notificação prévia?
5. **Backfill SLA**: qual o tamanho do histórico (quantos pedidos/estabelecimento)?
   Pra estimar tempo de execução do import inicial.

---

## Roadmap sugerido

1. **MVP (1 sprint)**: endpoint de backfill com paginação + idempotência.
   Validação contra 1 tenant seed.
2. **MVP+**: webhook incremental com HMAC + retry exponencial.
3. **Hardening**: suporte a atualização de status + anonimização via LGPD.
4. **V2**: match de cliente por `external_id` se Athos expuser; reconciliação
   de duplicatas.

ATHOS_CAMPAIGN_DATA_READY passa de NAO para SIM quando o MVP do backfill
estiver validado em produção com histórico real.

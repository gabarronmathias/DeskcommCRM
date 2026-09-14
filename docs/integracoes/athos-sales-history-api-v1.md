# API Sarah × Athos — Histórico de Vendas e Audiências de Campanha v1

Documentação de integração para a equipe da **Athos**. Esta API permite que a
Athos consulte, em tempo real, o histórico de compras de clientes cadastrados
em nossa base — incluindo o último pedido, agregados de gasto e a audiência
de clientes elegíveis para campanhas de reativação.

**Direção da integração:** a Athos **consulta** as nossas APIs. Este documento
**não cobre** o caminho inverso (ingestão de histórico da Athos para cá).

---

## 1. Base URL

```
https://crm.gabarronmathias.com
```

Todas as rotas abaixo são prefixadas por essa base.

---

## 2. Autenticação

Todas as requisições exigem um token de API server-to-server no header
`Authorization`:

```
Authorization: Bearer dsk_aabbccdd_<segredo>
```

- O token identifica uma **organização** (tenant) e os limites de quota;
- Tem escopo granular; para esta API o escopo necessário é **`orders:read`**;
- É **server-to-server**: nunca deve ser exposto em código de frontend,
  scripts de browser, app mobile ou qualquer contexto público;
- Pode ser revogado a qualquer momento pela nossa equipe — após revogação,
  chamadas subsequentes recebem `401` imediatamente;
- Toda resposta inclui `X-Request-Id` no header — guarde esse valor ao reportar
  incidente, ele correlaciona com nosso log de auditoria.

---

## 3. Endpoint A — Histórico de compras por cliente

`GET /api/v1/customers/{phone}/order-history`

Devolve o histórico completo de compras do cliente identificado pelo telefone,
incluindo cada pedido com seus itens, e agregados (total gasto, ticket médio,
datas da primeira e última compra, dias desde a última, top-5 produtos por
frequência).

### 3.1 Path params

| Nome    | Tipo   | Obrigatório | Descrição                                                                                          |
| ------- | ------ | ----------- | -------------------------------------------------------------------------------------------------- |
| `phone` | string | sim         | Telefone do cliente. Aceita formatos comuns (com ou sem `+55`, espaços, parênteses). Normalizamos para E.164 antes de buscar. |

### 3.2 Query params (todos opcionais)

| Nome     | Tipo     | Default | Descrição                                                                                       |
| -------- | -------- | ------- | ----------------------------------------------------------------------------------------------- |
| `from`   | ISO-8601 | —       | Pedidos a partir desta data (inclusivo). Ex.: `2026-01-01T00:00:00Z`                            |
| `to`     | ISO-8601 | —       | Pedidos até esta data (exclusivo). Janela semiaberta `[from, to)`.                              |
| `status` | string   | —       | Filtro por status do pedido. Valores canônicos: `pending`, `paid`, `cancelled`, `fulfilled`, `shipped`, `delivered`, `refunded`. Pseudo-status de conveniência: `not_cancelled` (exclui cancelados e estornados), `completed` (= `paid` + `fulfilled` + `shipped` + `delivered`). |
| `limit`  | int      | 50      | Tamanho da página (1 a 200).                                                                     |
| `cursor` | string   | —       | Cursor opaco retornado por uma chamada anterior; peça a próxima página com o mesmo valor de `meta.cursor`. |

### 3.3 Exemplo de request

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "https://crm.gabarronmathias.com/api/v1/customers/+5511999998888/order-history?limit=10&status=completed"
```

### 3.4 Exemplo de resposta (200)

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

Toda resposta (sucesso ou erro) inclui o header `X-Request-Id` com um
identificador único — guarde-o ao reportar incidente, ele correlaciona com
o log de auditoria do nosso lado.

### 3.5 Quando o cliente não existe (cold lead)

```json
{
  "data": {
    "customer_found": false,
    "query_phone_e164": "+5511999998888",
    "customer": null,
    "summary": {
      "total_orders": 0,
      "total_spent_cents": 0,
      "avg_ticket_cents": 0,
      "currency": "BRL",
      "first_order_at": null,
      "last_order_at": null,
      "days_since_last_order": null,
      "favorite_products": []
    },
    "orders": []
  },
  "meta": { "cursor": null, "has_more": false }
}
```

Útil para campanhas de aquisição (cliente válido, mas nunca comprou).

---

## 4. Endpoint B — Audiência de clientes por recência

`GET /api/v1/customers/purchase-recency`

Devolve a lista de clientes elegíveis para uma campanha segundo a **recência
do último pedido**. Caso de uso principal: campanhas de **reativação**
("clientes que não compram há X dias") ou de **aquisição fria**
("clientes que nunca compraram").

### 4.1 Query params

| Nome               | Tipo     | Default          | Descrição                                                                                                              |
| ------------------ | -------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `inactive_days`    | int      | **obrigatório**  | Janela mínima de inatividade em dias. `inactive_days=30` retorna clientes cujo último pedido elegível ocorreu há **30 dias ou mais**. |
| `min_orders`       | int      | 0                | Mínimo de pedidos elegíveis para o candidato aparecer.                                                                 |
| `min_spent_cents`  | int      | 0                | Mínimo de gasto acumulado em centavos.                                                                                  |
| `status`           | string   | `not_cancelled`  | Mesma semântica do Endpoint A (canônicos + pseudo).                                                                    |
| `limit`            | int      | 100              | Tamanho da página (1 a 500).                                                                                            |
| `cursor`           | string   | —                | Cursor opaco para a próxima página (use `meta.cursor` da resposta anterior).                                            |
| `has_orders`       | bool     | `true`           | `true` = reativação: só quem **tem** pedido cujo último está inativo. `false` = aquisição fria: só quem **nunca comprou**. |

### 4.2 Exclusões automáticas (LGPD)

Independente do filtro informado, **nunca** são retornados como candidatos:

- Clientes **bloqueados** (`is_blocked = true`);
- Clientes **anonimizados** (`is_anonymized = true`);
- Clientes **sem consentimento de marketing ativo** — interpretamos
  `consent.marketing.granted_at` ausente (incluindo `consent = {}`) como
  opt-out. Campanhas só incluem clientes que consentiram explicitamente em
  receber comunicações de marketing.

Estas exclusões são aplicadas **antes** da paginação. A resposta inclui
`has_marketing_consent` em cada candidato para deixar explícito por que ele
está (ou deixou de estar) na lista.

### 4.3 Exemplo de request

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "https://crm.gabarronmathias.com/api/v1/customers/purchase-recency?inactive_days=30&limit=100"
```

### 4.4 Exemplo de resposta (200)

```json
{
  "data": {
    "candidates": [
      {
        "contact_id": "cccccccc-3333-4000-8000-000000000001",
        "display_name": "Maria Silva",
        "phone_number": "+5511999998888",
        "last_activity_at": "2026-08-10T14:30:00Z",
        "tags": ["vip"],
        "has_marketing_consent": true,
        "total_orders": 5,
        "total_spent_cents": 20000,
        "avg_ticket_cents": 4000,
        "last_order_at": "2026-08-12T10:00:00Z",
        "last_order_id": "00000000-0000-4000-8000-0000000000b1",
        "days_since_last_order": 30,
        "last_order_items": [
          {
            "product_name": "Pizza Margherita",
            "quantity": 1,
            "unit_price_cents": 4500,
            "line_total_cents": 4500,
            "selected_modifiers": []
          }
        ],
        "favorite_products": [
          { "product_name": "Pizza Margherita", "quantity": 5, "order_count": 3 },
          { "product_name": "Coca-Cola 2L",     "quantity": 3, "order_count": 2 }
        ],
        "last_order_meta": {
          "external_id": "ext-001",
          "external_provider": "gm_crm_food",
          "status": "delivered",
          "total_cents": 4500,
          "currency": "BRL"
        }
      }
    ],
    "filters": {
      "inactive_days": 30,
      "min_orders": 0,
      "min_spent_cents": 0,
      "has_orders": true,
      "queried_at": "2026-09-11T12:00:00Z"
    }
  },
  "meta": {
    "cursor": "MjAyNi0wOC0xMlQxMDowMDowMHxjY2NjY2NjYy0zMzMzLTQwMDAtODAwMC0wMDAwMDAwMDAwMDE=",
    "has_more": true
  }
}
```

### 4.5 Lista vazia (audência sem candidatos)

```json
{
  "data": {
    "candidates": [],
    "filters": {
      "inactive_days": 30,
      "min_orders": 0,
      "min_spent_cents": 0,
      "has_orders": true,
      "queried_at": "2026-09-11T12:00:00Z"
    }
  },
  "meta": { "cursor": null, "has_more": false }
}
```

Retornar lista vazia é **resposta válida** — significa que, na janela
solicitada, nenhum cliente elegível foi encontrado.

### 4.6 Importante — esta API **NÃO dispara mensagem**

A rota de audiência é apenas de **seleção**. O envio de mensagens continua
sendo de responsabilidade do nosso fluxo interno, que respeita os mesmos
flags (`is_blocked`, `is_anonymized`, `has_marketing_consent`).

---

## 5. Paginação

Ambas as rotas usam **cursor opaco** em `meta.cursor`:

- Primeira chamada: omita `cursor`. A resposta traz `meta.cursor` apenas
  se houver mais páginas (`meta.has_more = true`).
- Próxima chamada: passe o `meta.cursor` da resposta anterior como
  query param `cursor`.
- Última página: `meta.cursor = null`, `meta.has_more = false`.

**Não construa** o cursor manualmente — ele é gerado pelo servidor e seu
formato pode mudar entre versões.

---

## 6. Erros

Toda resposta de erro segue o envelope:

```json
{
  "error": {
    "code": "<código>",
    "message": "<mensagem legível>"
  }
}
```

| Status | `code`             | Quando                                                                                                |
| ------ | ------------------ | ----------------------------------------------------------------------------------------------------- |
| 401    | `unauthenticated`  | Sem header `Authorization`, token malformado, expirado ou revogado.                                    |
| 403    | `forbidden_scope`  | Token válido mas sem o escopo `orders:read`. Solicite à nossa equipe um token com esse escopo.        |
| 422    | `validation_failed`| Path param ou query param em formato inválido (telefone impossível, `limit` fora de faixa, status desconhecido, cursor corrompido). |
| 500    | `internal_error`   | Erro interno do servidor. Faça retry com backoff exponencial. Em caso de persistência, reporte com o `X-Request-Id`. |

---

## 7. Segurança

- **HTTPS obrigatório** em todas as chamadas.
- O token Bearer é a única credencial — **não há** login por usuário/senha,
  cookie de sessão, ou OAuth nesta API.
- O token identifica **uma organização** — não vaza dados de outros tenants.
  Toda query executa com filtro explícito por `organization_id`.
- Token **nunca** deve aparecer em:
  - código JavaScript de página;
  - app mobile do usuário final;
  - logs de aplicação pública;
  - URL de navegador (fica em header `Authorization`, não em query string).
- Bloqueio imediato ao detectar comprometimento: solicite a revogação à
  nossa equipe.

---

## 8. Versionamento

Esta documentação descreve a **versão 1** (`v1`) da API.

Mudanças compatíveis (adição de campos em `data`, novos valores em
`status`, novos filtros opcionais) entram sem aviso prévio — o contrato
não quebra clientes que ignoram campos desconhecidos.

Mudanças incompatíveis (remoção de campo, mudança de tipo, novo
comportamento de filtro obrigatório) serão comunicadas com pelo menos
**7 dias de antecedência** antes de entrarem em produção, e uma nova
versão (`/api/v2/...`) será publicada em paralelo durante a transição.

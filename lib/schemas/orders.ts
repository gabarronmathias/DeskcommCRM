/**
 * Zod schemas para `/api/v1/customers/[phone]/order-history` (EPIC-21, Athos).
 *
 * Esta API é o contrato que a Sarah (motor de relacionamento) e o time Athos
 * consomem para ver o histórico de compras de um cliente e gerar campanhas
 * de recompra / reativação. Toda validação fica aqui — a rota só repassa
 * para a RPC `fn_orders_customer_history` (que é SECURITY INVOKER + STABLE
 * e filtra `organization_id` manualmente).
 *
 * A normalização do telefone é da RPC (reusa `fn_food_normalize_phone`), não
 * desta camada — este schema aceita formatos flexíveis (com `+`, espaços,
 * parênteses, com ou sem código de país) e a RPC decide o que é E.164 válido.
 */
import { z } from "zod";

/**
 * Status de pedido aceitos pelo contrato. "not_cancelled" e "completed" são
 * pseudo-status que a RPC traduz para o conjunto canônico
 * (pending/paid/fulfilled/shipped/delivered/refunded) — útil pra quem
 * prefere ler em linguagem de negócio sem precisar saber do vocabulário
 * interno.
 */
export const ORDER_STATUS_VALUES = [
  "pending",
  "paid",
  "cancelled",
  "fulfilled",
  "shipped",
  "delivered",
  "refunded",
  "not_cancelled",
  "completed",
] as const;
export type OrderStatusFilter = (typeof ORDER_STATUS_VALUES)[number];

/**
 * Query params de GET /api/v1/customers/[phone]/order-history.
 *
 * Tudo opcional exceto `phone` (path param) — defaults sensatos fazem a rota
 * funcionar para o caso comum (Sarah consulta "o que esse cliente comprou?"
 * sem precisar mandar filtros).
 *
 * `from`/`to` aceitam ISO-8601; a RPC compara como timestamptz e faz janela
 * semiaberta [from, to). Mandar `from` mas não `to` = "desde essa data";
 * mandar `to` mas não `from` = "até essa data"; sem nenhum = sem filtro de
 * período (padrão).
 *
 * `limit` default 50, max 200 — combina com o cap da RPC (`greatest(1,
 * least(coalesce(p_limit, 50), 200))`). Cliente típico de foodservice tem
 * poucos pedidos/ano; 50 cobre 1 página inteira de conversa da Sarah.
 */
export const orderHistoryQuerySchema = z.object({
  from: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO-8601; pedidos a partir de (inclusivo)."),
  to: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO-8601; pedidos até (exclusivo)."),
  status: z
    .enum(ORDER_STATUS_VALUES)
    .optional()
    .describe(
      "Filtro de status. 'not_cancelled' e 'completed' são pseudo-status traduzidos pela RPC.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Tamanho da página (1-200). Default 50."),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("Cursor opaco retornado por uma chamada anterior (próxima página)."),
});
export type OrderHistoryQuery = z.infer<typeof orderHistoryQuerySchema>;

/**
 * Path param `:phone` — aceitamos telefone com `+`, espaços, parênteses,
 * traços. A RPC normaliza via `fn_food_normalize_phone` (8-15 dígitos E.164).
 * Mínimo 8 dígitos porque 8 é o menor telefone E.164 válido (segundo a
 * constraint do CHECK em `contacts.phone_number`).
 */
export const customerPhoneParamSchema = z
  .string()
  .trim()
  .min(8)
  .max(32)
  .regex(/^[\d\s()+.-]+$/, "Use apenas dígitos e separadores comuns (+, espaço, -, (, )).");
export type CustomerPhoneParam = z.infer<typeof customerPhoneParamSchema>;

/**
 * Query params de `GET /api/v1/customers/purchase-recency` (EPIC-21 PARTE 3).
 *
 * Caso de uso principal: Sarah consulta "clientes que não compram há X dias"
 * pra campanha de reativação. `inactive_days` é obrigatório — é o que define
 * a audiência. Os demais filtros estreitam a janela sem mudar a semântica.
 *
 * LGPD é tratada dentro da RPC (ela já exclui `is_blocked`, `is_anonymized`
 * e contatos sem `consent.marketing.granted_at`). Não duplicamos o filtro
 * aqui — duplicar dá margem pra divergência se a regra mudar.
 *
 * Paginação: cursor opaco retornado por chamada anterior. Limite máximo 500
 * (combina com `greatest(1, least(coalesce(p_limit, 100), 500))` da RPC) —
 * Sarah normalmente consome página por página enquanto conversa; campanhas
 * batch podem puxar páginas até esgotar.
 */
export const purchaseRecencyQuerySchema = z.object({
  inactive_days: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .describe(
      "Janela mínima de inatividade em dias. 0 = audiência vazia (ninguém tem last_order_at <= now).",
    ),
  min_orders: z.coerce.number().int().min(0).max(10000).default(0),
  min_spent_cents: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  status: z
    .enum([
      "pending",
      "paid",
      "cancelled",
      "fulfilled",
      "shipped",
      "delivered",
      "refunded",
      "not_cancelled",
      "completed",
    ])
    .default("not_cancelled")
    .describe("Filtro dos pedidos elegíveis para o agregado."),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).max(512).optional(),
  has_orders: z
    .union([z.literal("true"), z.literal("false")])
    .default("true")
    .transform((v) => v === "true")
    .describe(
      "true (default) = reativação: só quem TEM pedido e está inativo. " +
        "false = aquisição: só quem NUNCA comprou (cold lead).",
    ),
});
export type PurchaseRecencyQuery = z.infer<typeof purchaseRecencyQuerySchema>;

/**
 * Input do MCP tool `crm_get_customer_last_order` (helper thin sobre
 * `fn_orders_customer_history` com limit=1). Reutiliza o schema de telefone
 * já existente.
 */
export const customerLastOrderInputSchema = z.object({
  phone: z
    .string()
    .trim()
    .min(8)
    .max(32)
    .describe(
      "Telefone do cliente em qualquer formato comum. A RPC normaliza para E.164.",
    ),
});
export type CustomerLastOrderInput = z.infer<typeof customerLastOrderInputSchema>;

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

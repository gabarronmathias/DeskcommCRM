/**
 * Capacidades de COMÉRCIO e PRIVACIDADE — o que o cliente comprou, o que existe
 * à venda, e quem pediu para sair.
 *
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4 para o contrato dos campos.
 */
import { declararTools } from "./tipos";

export const TOOLS_COMERCIO = declararTools([
  {
    name: "crm_list_contact_orders",
    category: "read",
    rotulo: "Ver as compras do cliente",
    explicacao:
      "Mostra o que este cliente já comprou, quanto pagou e como está a entrega, para o assistente não prometer prazo no escuro nem repetir uma oferta já aceita.",
    oQueToca: "Compras do cliente",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_get_customer_order_history",
    category: "read",
    rotulo: "Histórico completo de compras do cliente",
    explicacao:
      "Mostra o histórico completo de um cliente pelo telefone: quanto já gastou, quando foi a última compra, quais são os produtos favoritos e a lista de pedidos com itens. Use antes de propor uma campanha de recompra ou reativação: sem isso, o assistente pode oferecer o que a pessoa acabou de comprar.",
    oQueToca: "Histórico de vendas do cliente",
    risco: "seguro",
    pacotes: ["vender", "reter"],
  },
  {
    name: "crm_search_products",
    category: "read",
    rotulo: "Procurar produto na loja",
    explicacao:
      "Procura um produto pelo nome e devolve preço e quantidade em estoque, para o assistente responder com o dado da loja em vez de estimar.",
    oQueToca: "Catálogo da loja",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_get_customer_last_order",
    category: "read",
    rotulo: "Ver o ultimo pedido do cliente",
    explicacao:
      "Devolve o ultimo pedido do cliente pelo telefone - data, valor, itens e quantos dias fazem. Mais barato que pedir o historico inteiro, para responder 'quando foi a ultima compra?' sem pesar a conversa.",
    oQueToca: "Ultimo pedido do cliente",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_list_customers_by_purchase_recency",
    category: "read",
    rotulo: "Listar audiencia por tempo sem comprar",
    explicacao:
      "Lista clientes da loja que estao ha X dias sem comprar (reativacao) ou que nunca compraram (aquisicao). A lista ja vem com LGPD aplicada: bloqueado, anonimizado e sem opt-in de marketing sao excluidos antes de devolver. Use para montar campanhas - nao dispara mensagem sozinho.",
    oQueToca: "Audiencia de campanha por recorrencia",
    risco: "seguro",
    pacotes: ["vender", "reter"],
  },
  {
    name: "crm_list_privacy_requests",
    category: "read",
    rotulo: "Ver pedidos de privacidade",
    explicacao:
      "Mostra quem pediu para exportar ou apagar os próprios dados e qual o prazo, para o assistente parar de insistir com quem pediu para sair.",
    oQueToca: "Privacidade e dados do cliente",
    risco: "seguro",
    pacotes: ["organizar", "atender"],
  },
]);

"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDeliveryReport } from "@/hooks/metrics/useDeliveryReport";

function money(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function MetricCard({
  title,
  value,
  detail,
}: {
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

export function DeliveryReportPanel() {
  const report = useDeliveryReport();

  if (report.isLoading) {
    return <p className="text-sm text-muted-foreground">Carregando relatório do delivery…</p>;
  }
  if (report.isError || !report.data?.data) {
    return <p className="text-sm text-destructive">Erro ao carregar o relatório do delivery.</p>;
  }

  const r = report.data.data;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Delivery hoje</h2>
          <p className="text-sm text-muted-foreground">
            Resultado comercial da Sarah e dos pedidos concluídos desde o início do dia.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">Atualiza automaticamente a cada 30s</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          title="Clientes atendidos pela Sarah"
          value={String(r.sarah.contacts_served)}
          detail={`${r.sarah.messages_sent} mensagens enviadas pela IA`}
        />
        <MetricCard
          title="Pedidos do delivery"
          value={String(r.delivery.orders_count)}
          detail={`${money(r.delivery.gross_revenue_cents)} faturados · ticket médio ${money(r.delivery.average_ticket_cents)}`}
        />
        <MetricCard
          title="Vendas adicionais"
          value={String(r.upsell.orders_with_upsell)}
          detail={`${r.upsell.offers} ofertas · ${r.upsell.items_sold} itens vendidos · +${money(r.upsell.revenue_cents)}`}
        />
        <MetricCard
          title="Campanhas"
          value={String(r.campaigns.sent)}
          detail={`${r.campaigns.orders} pedidos atribuídos · ${money(r.campaigns.revenue_cents)} em vendas`}
        />
        <MetricCard
          title="Carrinhos recuperados"
          value={String(r.recoveries.orders)}
          detail={`${r.recoveries.sent} tentativas · ${money(r.recoveries.revenue_cents)} recuperados`}
        />
        <MetricCard
          title="Receita influenciada pela Sarah"
          value={money(r.sarah_influenced_revenue_cents)}
          detail="Pedidos ligados a venda adicional, campanha ou recuperação, sem duplicar o mesmo pedido."
        />
      </div>
    </section>
  );
}

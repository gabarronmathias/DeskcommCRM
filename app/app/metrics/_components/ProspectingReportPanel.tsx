"use client";

import type { ComponentType } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useProspectingMetrics } from "@/hooks/metrics/useProspectingMetrics";
import { CalendarCheck, ChatsCircle, ClockCountdown, PaperPlaneTilt } from "@/lib/ui/icons";

interface MetricItemProps {
  icon: ComponentType<{
    size?: number;
    weight?: "regular" | "duotone";
    className?: string;
    "aria-hidden"?: boolean;
  }>;
  label: string;
  value: number;
  detail: string;
  live?: boolean;
}

function MetricItem({ icon: Icon, label, value, detail, live = false }: MetricItemProps) {
  return (
    <div className="flex min-w-0 gap-4 p-5 xl:px-6 xl:py-5">
      <span
        className={
          live
            ? "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-info-bg text-info-fg"
            : "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
        }
      >
        <Icon size={18} weight="duotone" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-muted">{label}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums leading-none tracking-tight">
          {value}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-text-muted">{detail}</p>
      </div>
    </div>
  );
}

function LoadingPanel() {
  return (
    <Card aria-live="polite" aria-busy="true">
      <CardContent className="p-6">
        <p className="text-sm text-text-muted">Carregando atividade comercial da Sarah…</p>
      </CardContent>
    </Card>
  );
}

export function ProspectingReportPanel() {
  const report = useProspectingMetrics();

  if (report.isLoading) return <LoadingPanel />;

  if (report.isError || !report.data?.data) {
    return (
      <Card className="border-error/40">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <p className="text-sm font-medium text-text">Não foi possível carregar a prospecção.</p>
            <p className="mt-1 text-xs text-text-muted">
              Tente novamente para atualizar os indicadores.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => report.refetch()}>
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }

  const metrics = report.data.data;

  return (
    <section aria-labelledby="sarah-prospecting-title">
      <Card className="overflow-hidden">
        <CardHeader className="bg-surface-elevated/50 gap-3 border-b border-border p-5 sm:flex-row sm:items-end sm:justify-between sm:space-y-0 xl:px-6">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">
                Hoje
              </span>
              <span className="text-xs text-text-subtle">Desde 00h · horário de São Paulo</span>
            </div>
            <h2 id="sarah-prospecting-title" className="text-lg font-semibold tracking-tight">
              Prospecção comercial da Sarah
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Contato B2B com empresas de delivery para apresentar os serviços da Gabarron &amp;
              Mathias.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-text-subtle">
            <span className="size-2 rounded-full bg-success" aria-hidden />
            Atualiza a cada 30s
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="grid divide-y divide-border xl:grid-cols-4 xl:divide-x xl:divide-y-0">
            <MetricItem
              icon={PaperPlaneTilt}
              label="Mensagens enviadas"
              value={metrics.prospecting_messages_sent}
              detail={`${metrics.opening_messages_sent} primeiros contatos · ${metrics.followups_sent} follow-ups enviados`}
            />
            <MetricItem
              icon={ChatsCircle}
              label="Empresas que responderam"
              value={metrics.replies_received}
              detail="Empresas diferentes que responderam hoje"
            />
            <MetricItem
              icon={CalendarCheck}
              label="Reuniões agendadas"
              value={metrics.meetings_scheduled}
              detail="Oportunidades que chegaram à etapa de reunião hoje"
            />
            <MetricItem
              icon={ClockCountdown}
              label="Follow-ups ativos"
              value={metrics.followups_active}
              detail="Retornos pendentes ou em processamento agora"
              live
            />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const useProspectingMetricsMock = vi.fn();

vi.mock("@/hooks/metrics/useProspectingMetrics", () => ({
  useProspectingMetrics: () => useProspectingMetricsMock(),
}));

vi.mock("@/lib/ui/icons", () => ({
  CalendarCheck: () => <span />,
  ChatsCircle: () => <span />,
  ClockCountdown: () => <span />,
  PaperPlaneTilt: () => <span />,
}));

import { ProspectingReportPanel } from "@/app/app/metrics/_components/ProspectingReportPanel";

describe("ProspectingReportPanel", () => {
  it("mostra a atuação B2B da Sarah com os quatro indicadores comerciais", () => {
    useProspectingMetricsMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        data: {
          leads_captured_today: 18,
          leads_new: 18,
          prospecting_messages_sent: 24,
          opening_messages_sent: 20,
          replies_received: 7,
          response_rate: 0.35,
          qualified_leads: 4,
          meetings_scheduled: 3,
          followups_sent: 4,
          followups_active: 9,
          opt_outs: 1,
          send_failures: 0,
          since: "2026-08-23T03:00:00.000Z",
          to: "2026-08-23T15:00:00.000Z",
        },
      },
    });

    render(<ProspectingReportPanel />);

    expect(
      screen.getByRole("heading", { name: "Prospecção comercial da Sarah" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/contato b2b com empresas de delivery/i)).toBeInTheDocument();

    const sent = screen.getByText("Mensagens enviadas").parentElement;
    const replies = screen.getByText("Empresas que responderam").parentElement;
    const meetings = screen.getByText("Reuniões agendadas").parentElement;
    const followups = screen.getByText("Follow-ups ativos").parentElement;

    expect(sent).not.toBeNull();
    expect(replies).not.toBeNull();
    expect(meetings).not.toBeNull();
    expect(followups).not.toBeNull();
    expect(within(sent!).getByText("24")).toBeInTheDocument();
    expect(
      within(sent!).getByText(/20 primeiros contatos · 4 follow-ups enviados/),
    ).toBeInTheDocument();
    expect(within(replies!).getByText("7")).toBeInTheDocument();
    expect(within(meetings!).getByText("3")).toBeInTheDocument();
    expect(within(followups!).getByText("9")).toBeInTheDocument();

    expect(screen.queryByText("Pedidos do delivery")).not.toBeInTheDocument();
    expect(screen.queryByText("Receita influenciada pela Sarah")).not.toBeInTheDocument();
  });
});

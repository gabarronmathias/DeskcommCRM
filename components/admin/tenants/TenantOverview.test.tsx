import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { TenantCounts, TenantOrganization } from "@/hooks/useTenantDetail";
import { TenantOverview } from "./TenantOverview";

const ORG: TenantOrganization = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "acme",
  display_name: "Acme",
  legal_name: "Acme Comércio LTDA",
  cnpj: "00.000.000/0001-00",
  status: "active",
  onboarded_at: "2026-01-02T12:00:00.000Z",
  suspended_at: null,
  created_at: "2026-01-01T12:00:00.000Z",
  settings: { plan: "pro" },
};

const COUNTS: TenantCounts = {
  user_count: 3,
  conversations_count: 10,
  messages_count: 100,
  leads_count: 5,
  orders_count: 2,
  lgpd_requests_pending: 0,
  ai_invocations_30d: 42,
  waha_sessions_count: 1,
};

describe("TenantOverview", () => {
  it("mostra dados do tenant sem apresentar integração de loja", () => {
    render(<TenantOverview organization={ORG} counts={COUNTS} />);

    expect(screen.getByText("Acme Comércio LTDA")).toBeInTheDocument();
    expect(screen.getByText("WAHA sessions")).toBeInTheDocument();
    expect(screen.queryByText(/Nuvemshop/i)).not.toBeInTheDocument();
  });
});

import { describe, expect, it } from "vitest";

import { pediuOptOut } from "@/lib/channels/pos-entrada";
import {
  FOLLOWUP_MESSAGE,
  isWithinBusinessHours,
  loadProspectingConfig,
  OPENING_MESSAGE,
  SARAH_POSITIONING,
} from "./config";
import { domainOf, normalizeBrazilianCommercialPhone, segmentTag } from "./normalization";
import {
  contactIdentityFromPhoneCheck,
  contactSourceMetadataWithWaLid,
} from "./dispatch";

describe("prospecção foodservice", () => {
  it("normaliza telefone comercial brasileiro e rejeita forma curta", () => {
    expect(normalizeBrazilianCommercialPhone("(12) 99999-0000")).toBe("+5512999990000");
    expect(normalizeBrazilianCommercialPhone("12345")).toBeNull();
  });

  it("normaliza domínio e segmento sem criar tags instáveis", () => {
    expect(domainOf("https://www.exemplo.com.br/cardapio")).toBe("exemplo.com.br");
    expect(segmentTag("Restaurante japonês / sushi")).toBe("japones");
  });

  it("personaliza a abertura sem inventar dono ou relacionamento anterior", () => {
    const text = OPENING_MESSAGE("Padaria Teste");
    expect(text).toContain("Vi a Padaria Teste");
    expect(text).toContain("vocês trabalham com delivery hoje?");
    expect(text).not.toContain("obrigado por entrar em contato");
    expect(text).not.toContain("dono");
  });

  it("mantém o posicionamento da Sarah como agente de relacionamento e vendas", () => {
    expect(SARAH_POSITIONING).toContain("máquina de vendas recorrentes");
    expect(FOLLOWUP_MESSAGE).toContain("agente de relacionamento e vendas");
    expect(FOLLOWUP_MESSAGE).toContain("aumenta o ticket durante o pedido");
    expect(FOLLOWUP_MESSAGE).toContain("recupera vendas não concluídas");
    expect(FOLLOWUP_MESSAGE).toContain("faz follow-up automaticamente");
    expect(FOLLOWUP_MESSAGE).toContain("reativa clientes que pararam de comprar");
    expect(FOLLOWUP_MESSAGE).toContain("cria campanhas para trazer a base de volta");
  });

  it.each([
    "STOP",
    "Não tenho interesse.",
    "Não me chama mais",
    "Remova meu número",
    "Não envie mensagens",
    "Não quero receber mais",
  ])("reconhece opt-out explícito: %s", (text) => expect(pediuOptOut(text)).toBe(true));

  it("não bloqueia conversa normal com palavra parecida", () => {
    expect(pediuOptOut("Vou parar por aqui e amanhã continuamos")).toBe(false);
    expect(pediuOptOut("Não quero receber ligação, prefiro WhatsApp")).toBe(false);
  });

  it("nasce desligada, em dry-run e limitada a 20", () => {
    const old = { ...process.env };
    delete process.env.PROSPECTING_ENABLED;
    delete process.env.OUTBOUND_ENABLED;
    delete process.env.PROSPECTING_DRY_RUN;
    delete process.env.PROSPECTING_DAILY_LIMIT;
    const config = loadProspectingConfig();
    expect(config).toMatchObject({
      enabled: false,
      outboundEnabled: false,
      dryRun: true,
      dailyLimit: 20,
    });
    process.env = old;
  });

  it("respeita janela comercial de segunda a sábado", () => {
    const cfg = {
      ...loadProspectingConfig(),
      timezone: "America/Sao_Paulo",
      businessHourStart: 9,
      businessHourEnd: 18,
    };
    expect(isWithinBusinessHours(cfg, new Date("2026-08-21T15:00:00Z"))).toBe(true);
    expect(isWithinBusinessHours(cfg, new Date("2026-08-21T21:30:00Z"))).toBe(true);
    expect(isWithinBusinessHours(cfg, new Date("2026-08-22T15:00:00Z"))).toBe(true);
    expect(isWithinBusinessHours(cfg, new Date("2026-08-23T15:00:00Z"))).toBe(false);
  });

  it("usa a identidade real devolvida pelo WhatsApp para número brasileiro", () => {
    expect(
      contactIdentityFromPhoneCheck(
        {
          numberExists: true,
          chatId: "987654321@lid",
          pn: "5512999990000@c.us",
        },
        "+5512999990000",
      ),
    ).toEqual({
      phoneNumber: "+5512999990000",
      waLid: "987654321",
    });
    expect(
      contactIdentityFromPhoneCheck(
        {
          numberExists: true,
          chatId: "5512888880000@c.us",
          pn: null,
        },
        "+5512999990000",
      ),
    ).toEqual({
      phoneNumber: "+5512888880000",
      waLid: null,
    });
    expect(
      contactIdentityFromPhoneCheck(
        {
          numberExists: false,
          chatId: null,
          pn: null,
        },
        "+5512999990000",
      ),
    ).toBeNull();
  });

  it("grava o LID na origem da coluna calculada do contato", () => {
    expect(contactSourceMetadataWithWaLid({ source: "spreadsheet" }, "987654321")).toEqual({
      source: "spreadsheet",
      waha_lid: "987654321@lid",
    });
    expect(
      contactSourceMetadataWithWaLid(
        { source: "spreadsheet", waha_lid: "stale@lid" },
        null,
      ),
    ).toEqual({ source: "spreadsheet" });
  });
});

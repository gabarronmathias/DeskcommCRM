/**
 * Testes do `resolveSessionRef` — em particular o fail-closed em
 * placeholders óbvios (bug do 2026-09-04: WAHA 422 "Session 'default' does
 * not exist").
 */
import { describe, expect, it } from "vitest";

import { ChannelSessionUnresolvedError, resolveSessionRef } from "./session-ref";

describe("resolveSessionRef — fail closed em placeholders", () => {
  it("cenario 8: WAHA com waha_session_name real devolve o nome", () => {
    const r = resolveSessionRef({ provider: "waha", waha_session_name: "sarah-gb-sjc" });
    expect(r).toBe("sarah-gb-sjc");
  });

  it("cenario 9a: WAHA com waha_session_name='default' LANÇA (fail closed)", () => {
    expect(() =>
      resolveSessionRef({ provider: "waha", waha_session_name: "default" }),
    ).toThrow(ChannelSessionUnresolvedError);
  });

  it("cenario 9b: WAHA com waha_session_name vazia LANÇA", () => {
    expect(() => resolveSessionRef({ provider: "waha", waha_session_name: "" })).toThrow(
      ChannelSessionUnresolvedError,
    );
  });

  it("cenario 9c: WAHA com waha_session_name='   ' (whitespace) LANÇA", () => {
    expect(() => resolveSessionRef({ provider: "waha", waha_session_name: "   " })).toThrow(
      ChannelSessionUnresolvedError,
    );
  });

  it("cenario 9d: Meta com meta_phone_number_id vazio NÃO LANÇA (Meta tem fallback de env)", () => {
    // Diferente do WAHA: o adapter do Meta Cloud carrega credenciais no
    // próprio `resolveMetaCreds`, e ref vazio significa "cai no env". O
    // fail-closed aqui quebraria a Fase 3b sem motivo — o adapter já tem
    // a própria defesa.
    const r = resolveSessionRef({ provider: "meta_cloud", meta_phone_number_id: "" });
    expect(r).toBe("");
  });

  it("cenario 9e: Zernio com zernio_account_id vazio NÃO LANÇA (Zernio tem fallback)", () => {
    const r = resolveSessionRef({ provider: "zernio", zernio_account_id: "" });
    expect(r).toBe("");
  });

  it("cenario 9f: Erro carrega provider e attemptedRef para diagnóstico", () => {
    try {
      resolveSessionRef({ provider: "waha", waha_session_name: "DEFAULT" });
      expect.fail("deveria ter lançado");
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelSessionUnresolvedError);
      const e = err as ChannelSessionUnresolvedError;
      expect(e.provider).toBe("waha");
      expect(e.attemptedRef).toBe("DEFAULT");
      expect(e.message).toContain("channel_session_unresolved");
      expect(e.message).toContain("waha");
      expect(e.message).toContain("DEFAULT");
    }
  });

  it("cenario normal: meta_cloud com id real funciona", () => {
    const r = resolveSessionRef({ provider: "meta_cloud", meta_phone_number_id: "1234567890" });
    expect(r).toBe("1234567890");
  });
});

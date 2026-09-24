import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import {
  claimsOrderWasConfirmed,
  shouldBlockUnverifiedAthosConfirmation,
  UNVERIFIED_ATHOS_ORDER_REPLY,
} from '../../lib/foodservice/athos/order-confirmation-guard';

describe('Athos order confirmation guard', () => {
  it.each([
    'Perfeito, Thailer — seu pedido está confirmado: 2 tortas.',
    'Perfeito — confirmei: 2 tortas para retirada.',
    'Pedido registrado! Obrigada.',
  ])('detecta uma confirmação afirmativa: %s', (text) => {
    expect(claimsOrderWasConfirmed(text)).toBe(true);
  });

  it.each([
    'Seu pedido ainda não está confirmado por aqui.',
    'Não consegui registrar o pedido.',
    'Quer confirmar o pedido?',
    'O cardápio está disponível.',
  ])('não bloqueia uma frase sem confirmação: %s', (text) => {
    expect(claimsOrderWasConfirmed(text)).toBe(false);
  });

  it('bloqueia a promessa quando a loja está habilitada mas não há pedido verificado', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ enabled: true, verified: false }] });
    const pool = { query } as unknown as pg.Pool;
    expect(await shouldBlockUnverifiedAthosConfirmation(pool, 'org', 'contact', 'conversation')).toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual(['org', 'contact', 'conversation', 48]);
    expect(UNVERIFIED_ATHOS_ORDER_REPLY).toContain('ainda não está confirmado');
  });

  it.each([
    { enabled: true, verified: true },
    { enabled: false, verified: false },
  ])('não altera atendimento fora do caso sem pedido: %j', async (row) => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [row] }) } as unknown as pg.Pool;
    expect(await shouldBlockUnverifiedAthosConfirmation(pool, 'org', 'contact', 'conversation')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { parsePickupSchedule } from '../../lib/foodservice/athos/pickup-schedule';

const now = new Date('2026-09-25T13:00:00.000Z'); // 10h in São Paulo
const timezone = 'America/Sao_Paulo';

describe('retirada Athos', () => {
  it('interpreta amanhã às 10h no fuso da organização', () => {
    expect(parsePickupSchedule('vou retirar amanhã às 10h', now, timezone)).toEqual({
      kind: 'scheduled',
      value: { scheduledAtLocal: '2026-09-26T10:00:00', timezone },
    });
  });

  it('aceita data explícita e minutos', () => {
    expect(parsePickupSchedule('retirada dia 27/09 às 10h30', now, timezone)).toEqual({
      kind: 'scheduled',
      value: { scheduledAtLocal: '2026-09-27T10:30:00', timezone },
    });
    expect(parsePickupSchedule('vou retirar amanhã as 10:30', now, timezone)).toEqual({
      kind: 'scheduled',
      value: { scheduledAtLocal: '2026-09-26T10:30:00', timezone },
    });
  });

  it('não inventa horário ausente, inválido ou passado', () => {
    expect(parsePickupSchedule('para retirada', now, timezone).kind).toBe('incomplete');
    expect(parsePickupSchedule('retirar amanhã às 25h', now, timezone).kind).toBe('incomplete');
    expect(parsePickupSchedule('retirar hoje às 09h', now, timezone).kind).toBe('incomplete');
    expect(parsePickupSchedule('retirar dia 31/09 às 11h', now, timezone).kind).toBe('incomplete');
  });

  it('permite completar uma retirada já indicada sem repetir o verbo', () => {
    expect(parsePickupSchedule('amanhã às 10h', now, timezone, true).kind).toBe('scheduled');
    expect(parsePickupSchedule('2 pessoas', now, timezone, true).kind).toBe('none');
  });
});

/**
 * Test integrado do gate 2 (achado 4 refinado) — quando a regex de keywords casa,
 * a closure DEVE passar `minimal: true` pro classificador LLM (prompt reduzido).
 *
 * Cobertura:
 * - "somos em 6 pessoas" → zero LLM (regex não casa)
 * - "garanto entrega amanhã" → LLM é chamado COM prompt mínimo
 * - "nossa entrega é rápida" → zero LLM (slogan sem keyword concreta)
 *
 * Ver `lib/agent-engine/guardrails/promise/keywords.ts` (PROMISE_SEMANTIC_FAST_SKIP)
 * e `lib/agent-engine/guardrails/promise/semantic.ts` (PROMISE_SEMANTIC_MINIMAL_INSTRUCTION).
 */
import { describe, expect, it } from 'vitest';

import {
  PROMISE_SEMANTIC_FAST_SKIP,
  hasPromiseKeyword,
} from '../../lib/agent-engine/guardrails/promise/keywords';
import {
  PROMISE_SEMANTIC_INSTRUCTION as INSTRUCTION_STD,
  PROMISE_SEMANTIC_MINIMAL_INSTRUCTION as INSTRUCTION_MIN,
} from '../../lib/agent-engine/guardrails/promise/semantic';

describe('promise-semantic gate 2 — minimal prompt quando regex casa; classificador nunca é pulado', () => {
  it('"somos em 6 pessoas" → regex não casa, classificador LLM AINDA RODA com prompt PADRÃO (não é prova de ausência)', () => {
    // ⚠️ BLOCO 1 (modo encerramento 2026-09-13): ausência de match lexical NÃO
    // prova ausência de promessa. A regex é só escalonamento positivo; quando
    // não casa, o classificador LLM é chamado com prompt PADRÃO.
    expect(hasPromiseKeyword('somos em 6 pessoas')).toBe(false);
  });

  it('"confirmo amanhã para você" → regex casa, LLM com prompt MÍNIMO é chamado', () => {
    expect(hasPromiseKeyword('confirmo amanhã para você')).toBe(true);
  });

  it('"nossa entrega é rápida" → regex não casa (slogan sem keyword concreta), classificador LLM AINDA RODA', () => {
    expect(hasPromiseKeyword('nossa entrega é rápida')).toBe(false);
  });

  it('prompt MÍNIMO é menor que o prompt PADRÃO (reduz tokens)', () => {
    expect(INSTRUCTION_MIN.length).toBeLessThan(INSTRUCTION_STD.length);
  });

  it('prompt MÍNIMO mantém o output JSON exigido (isPromise, suspectPhrase)', () => {
    expect(INSTRUCTION_MIN).toContain('isPromise');
    expect(INSTRUCTION_MIN).toContain('suspectPhrase');
  });

  it('prompt PADRÃO mantém a definição completa (caso sem regex)', () => {
    expect(INSTRUCTION_STD).toContain('cortesia');
    expect(INSTRUCTION_STD).toContain('isentar');
    expect(INSTRUCTION_STD).toContain('prazo');
  });

  it('regex PT-BR é otimista (casa mais que devia → LLM desambigua)', () => {
    // "garantimos qualidade" — slogan genérico que casa a regex; LLM decide false
    expect(PROMISE_SEMANTIC_FAST_SKIP.test('garantimos qualidade')).toBe(true);
    // "garanto entrega amanhã" — compromisso concreto; LLM decide true
    expect(PROMISE_SEMANTIC_FAST_SKIP.test('garanto entrega amanhã')).toBe(true);
  });
});

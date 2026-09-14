/**
 * Testes do escalonamento positivo por regex de keywords PT-BR (briefing latência
 * Sarah 2026-09-12, achado 4 / 2026-09-13 bloco 1). A regex casa POTENCIAL
 * promessa em texto livre; quando casa, o classificador LLM é chamado com
 * prompt MÍNIMO (escalonamento positivo). Quando NÃO casa, o classificador LLM
 * ainda é chamado COM PROMPT PADRÃO — ausência de match lexical NÃO prova
 * ausência de promessa. O classificador NUNCA é pulado.
 *
 * Ver `lib/agent-engine/guardrails/promise/keywords.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  PROMISE_SEMANTIC_FAST_SKIP,
  hasPromiseKeyword,
} from '../../lib/agent-engine/guardrails/promise/keywords';

describe('promise-semantic escalonamento por regex (achado 4 / bloco 1)', () => {
  describe('cenários SEM match (classificador LLM ainda roda com prompt PADRÃO — fail-open proibido)', () => {
    it('"somos em 6 pessoas" → SEM keyword de promessa, regex não casa', () => {
      expect(hasPromiseKeyword('somos em 6 pessoas')).toBe(false);
    });

    it('resposta curta de turno (party size, confirmação de nome) → SEM keyword', () => {
      expect(hasPromiseKeyword('ok')).toBe(false);
      expect(hasPromiseKeyword('pode ser')).toBe(false);
      expect(hasPromiseKeyword('meu nome é Carlos')).toBe(false);
      expect(hasPromiseKeyword('para 8 pessoas')).toBe(false);
      expect(hasPromiseKeyword('para o jantar de sábado')).toBe(false);
      expect(hasPromiseKeyword('sim, quero o bolo de chocolate')).toBe(false);
    });

    it('perguntas e saudações → SEM keyword', () => {
      expect(hasPromiseKeyword('oi, tudo bem?')).toBe(false);
      expect(hasPromiseKeyword('como funciona o cardápio?')).toBe(false);
      expect(hasPromiseKeyword('qual o sabor do bolo?')).toBe(false);
    });

    it('descrições de horário/empresa → SEM keyword', () => {
      expect(hasPromiseKeyword('atendemos de terça a domingo das 18h às 23h')).toBe(false);
      expect(hasPromiseKeyword('somos uma padaria no centro')).toBe(false);
    });

    it('próximos passos vagos sem compromisso concreto → SEM keyword', () => {
      expect(hasPromiseKeyword('a gente vê isso depois')).toBe(false);
      expect(hasPromiseKeyword('quando puder me chama')).toBe(false);
    });
  });

  describe('cenários COM promessa/compromisso (regex casa → LLM ainda roda pra desambiguar)', () => {
    it('"confirmo amanhã para você" → keyword "confirmo" casa', () => {
      expect(hasPromiseKeyword('confirmo amanhã para você')).toBe(true);
    });

    it('"garanto entrega amanhã" → keywords "garanto" + "entrega amanhã" casam', () => {
      expect(hasPromiseKeyword('garanto entrega amanhã')).toBe(true);
    });

    it('"faço de graça" → keyword "grátis" casa', () => {
      expect(hasPromiseKeyword('faço de graça')).toBe(true);
    });

    it('"te dou uma cortesia" → keyword "cortesia" casa', () => {
      expect(hasPromiseKeyword('te dou uma cortesia')).toBe(true);
    });

    it('"fica pronto até sexta" → keywords "fica pronto" + "pronto até" casam', () => {
      expect(hasPromiseKeyword('fica pronto até sexta')).toBe(true);
    });

    it('"isento a taxa de entrega" → keyword "isento" + "taxa" casa', () => {
      expect(hasPromiseKeyword('isento a taxa de entrega')).toBe(true);
    });

    it('"resolvo até amanhã" → keyword "resolvo até" casa', () => {
      expect(hasPromiseKeyword('resolvo até amanhã')).toBe(true);
    });

    it('"100% de desconto" → keyword "100% de desconto" casa', () => {
      expect(hasPromiseKeyword('vou te dar 100% de desconto')).toBe(true);
    });
  });

  describe('slogans/genéricos (regex casa MAS é inocente — LLM classifica)', () => {
    it('"garantimos qualidade" → keyword "garanti" casa; LLM desambigua como slogan', () => {
      // proposital: a regex casa pra preservar a checagem do LLM
      expect(hasPromiseKeyword('garantimos qualidade')).toBe(true);
    });

    it('"nossa entrega é rápida" → SEM keyword concreta (slogan sem prazo/compromisso) — fast-skip direto, SEM LLM', () => {
      // "entrega é rápida" não é promessa concreta (sem prazo, sem compromisso)
      // — fast-skip deve disparar SEM chamar o classificador LLM.
      expect(hasPromiseKeyword('nossa entrega é rápida')).toBe(false);
    });

    it('"10x mais rápido que a concorrência" → keyword casa (slogan); LLM desambigua', () => {
      // sem keyword explícita aqui — deve ser false (slogan sem comprom. concreto)
      expect(hasPromiseKeyword('10x mais rápido que a concorrência')).toBe(false);
    });
  });

  describe('propriedades do regex', () => {
    it('é case-insensitive', () => {
      expect(hasPromiseKeyword('CONFIRMO AMANHÃ')).toBe(true);
      expect(hasPromiseKeyword('Grátis para você')).toBe(true);
    });

    it('exporta o regex cru para tooling/diagnóstico', () => {
      expect(PROMISE_SEMANTIC_FAST_SKIP).toBeInstanceOf(RegExp);
      expect(PROMISE_SEMANTIC_FAST_SKIP.flags).toContain('i');
      // flag 'u' (unicode) — sem ela, \b não reconhece letras acentuadas PT-BR
      // ('é', 'ç', 'ã') como word chars, quebrando word-boundary nas keywords.
      expect(PROMISE_SEMANTIC_FAST_SKIP.flags).toContain('u');
    });
  });
});

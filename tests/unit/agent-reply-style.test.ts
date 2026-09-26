import { describe, expect, it } from 'vitest';
import { removeRepeatedCustomerName } from '../../lib/agent-engine/agent/reply-style';

describe('removeRepeatedCustomerName', () => {
  it('mantem o nome na primeira resposta', () => {
    expect(removeRepeatedCustomerName('Perfeito, Thailer! Como posso ajudar?', 'Thailer Silva', 'Sarah', false))
      .toBe('Perfeito, Thailer! Como posso ajudar?');
  });

  it('remove o nome repetido sem alterar a pergunta', () => {
    expect(removeRepeatedCustomerName('Perfeito, Thailer! Para 5 pessoas, prefere doce?', 'Thailer', 'Sarah', true))
      .toBe('Perfeito! Para 5 pessoas, prefere doce?');
  });

  it('remove reapresentacao repetida da Sarah', () => {
    expect(removeRepeatedCustomerName('Oi Thailer — aqui é a Sarah, da loja. Posso ajudar?', 'Thailer', 'Sarah', true))
      .toBe('Posso ajudar?');
  });

  it('mantem o texto se nao ha nome seguro', () => {
    expect(removeRepeatedCustomerName('Olá, cliente!', null, 'Sarah', true)).toBe('Olá, cliente!');
  });
});

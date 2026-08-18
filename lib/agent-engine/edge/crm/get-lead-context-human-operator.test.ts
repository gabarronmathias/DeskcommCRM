import { expect, it } from 'vitest';

import { frameHumanOperatorBody } from './get-lead-context';

it('marca mensagem manual do estabelecimento como fala humana, nao da Sarah', () => {
  const framed = frameHumanOperatorBody('Eu vou para a Chopperia às 14h.');

  expect(framed).toContain('ATENDENTE HUMANO');
  expect(framed).toContain('NÃO pela Sarah');
  expect(framed).toContain('Eu vou para a Chopperia às 14h.');
  expect(framed).toContain('Nunca atribua à Sarah');
});
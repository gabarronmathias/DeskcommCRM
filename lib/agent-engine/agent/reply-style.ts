/** Guardrail de estilo para agentes que pedem o nome do cliente uma vez só. */
export function removeRepeatedCustomerName(
  body: string,
  contactName: string | null | undefined,
  agentName: string,
  hasPreviousOutbound: boolean,
): string {
  if (!hasPreviousOutbound || !contactName) return body;
  const firstName = contactName.trim().split(/\s+/u)[0] ?? '';
  if (!/^[\p{L}][\p{L}'-]{1,39}$/u.test(firstName)) return body;
  const name = escapeRegex(firstName);
  const agent = escapeRegex(agentName);

  // Remove a reapresentação inteira, sem deixar "Oi — aqui é..." para trás.
  let result = body.replace(
    new RegExp(`^\\s*(?:Oi|Olá)[,!]?\\s+${name}\\s*[—-]\\s*aqui\\s+é\\s+a?\\s*${agent}\\b[^.!?]*[.!?]?\\s*`, 'iu'),
    '',
  );
  // "Perfeito, Thailer!" -> "Perfeito!"; preserva o restante da resposta.
  result = result.replace(new RegExp(`,\\s*${name}(?=[!,.?:;\\s—-]|$)`, 'giu'), '');
  // "Oi Thailer — ..." -> "Oi, ...".
  result = result.replace(new RegExp(`^(Oi|Olá)\\s+${name}\\s*[,!—-]?\\s*`, 'iu'), '$1, ');
  return result.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

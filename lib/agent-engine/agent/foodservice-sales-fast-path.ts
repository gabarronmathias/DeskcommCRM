export type FoodserviceFastPathKind = 'party_size' | 'simple_sales' | 'athos_bridge';

export interface FoodserviceHistoryMessage {
  direction: 'inbound' | 'outbound';
  body: string;
  sentAt: string;
}

export type FoodserviceFastPathDecision =
  | {
      matched: true;
      kind: FoodserviceFastPathKind;
      reason: string;
      response: string;
      llmCallsBeforeSend: 0;
      partySize: number | null;
    }
  | {
      matched: false;
      kind: null;
      reason: string;
      llmCallsBeforeSend: 0;
    };

const URL_RE = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|com\.br|net|org)\b)/i;
const HUMAN_RE = /\b(?:humano|atendente|pessoa\s+real|falar\s+com\s+(?:algu[eé]m|uma\s+pessoa))\b/i;
const OPTOUT_RE = /\b(?:n[aã]o\s+quero\s+mais\s+receber|pare\s+de\s+me\s+mandar|me\s+tira\s+da\s+lista|descadastrar|opt[- ]?out)\b/i;
const SEVERE_RE = /\b(?:procon|advogad[oa]|processo|jur[ií]dic[oa]|fraude|intoxica[cç][aã]o|amea[cç]a|reclama[cç][aã]o\s+grave|cobran[cç]a\s+indevida)\b/i;
const INJECTION_RE = /\b(?:ignore|ignorar|desconsidere|revele|mostre)\b.{0,35}\b(?:instru[cç][oõ]es|prompt|sistema|system|developer)\b|\bjailbreak\b/i;
const PROMISE_RE = /\b(?:desconto|garant(?:a|e|ia|ido)|promet(?:a|e|o)|pre[cç]o|promo[cç][aã]o|prazo)\b/i;
const COMMERCIAL_RE = /\b(?:salgad|doc|torta|bolo|festa|evento|anivers[aá]rio|card[aá]pio|pedido|encomenda|pessoas?|quantidade|sabores?|chocolate|entrega|retirada)\w*/i;
const PARTY_QUESTION_RE = /\b(?:quantas?\s+pessoas?|para\s+quantas?|pra\s+quantas?)\b/i;
const DATE_RE = /\b(?:hoje|amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|\d{1,2}[/-]\d{1,2})\b/i;
const PREFERENCE_RE = /\b(?:salgad|doc|chocolate|os\s+dois|combina[cç][aã]o)\w*/i;

const PARTY_PATTERNS = [
  /^(?:somos(?:\s+em)?|seremos|vai\s+dar)\s+(\d{1,3})(?:\s+pessoas?)?$/i,
  /^(?:[eé]\s+)?(?:para|pra)\s+(?:umas?|uns?)?\s*(\d{1,3})(?:\s+pessoas?)?$/i,
  /^vai\s+ser\s+(?:para|pra)\s+(\d{1,3})(?:\s+pessoas?)?$/i,
];

export function extractPartySize(text: string): number | null {
  const normalized = normalize(text);
  for (const pattern of PARTY_PATTERNS) {
    const match = pattern.exec(normalized);
    const size = match?.[1] === undefined ? NaN : Number.parseInt(match[1], 10);
    if (Number.isInteger(size) && size >= 1 && size <= 300) return size;
  }
  return null;
}

export function decideFoodserviceSalesFastPath(input: {
  enabled: boolean;
  text: string;
  messageType: string;
  history: FoodserviceHistoryMessage[];
  contactName?: string | null;
  now?: Date;
}): FoodserviceFastPathDecision {
  if (!input.enabled) return noMatch('flag_disabled');
  const text = input.text.trim();
  if (input.messageType !== 'text') return noMatch('media_or_non_text');
  if (text.length === 0 || text.length > 120) return noMatch('text_not_short');
  if (URL_RE.test(text)) return noMatch('url_present');
  if (HUMAN_RE.test(text)) return noMatch('human_requested');
  if (OPTOUT_RE.test(text)) return noMatch('opt_out');
  if (SEVERE_RE.test(text)) return noMatch('severe_or_legal');
  if (INJECTION_RE.test(text)) return noMatch('prompt_injection');
  if (PROMISE_RE.test(text)) return noMatch('promise_discount_or_price');
  if (!hasRecentCommercialContext(input.history, input.now ?? new Date())) {
    return noMatch('no_recent_commercial_context');
  }

  const partySize = extractPartySize(text);
  if (partySize !== null) {
    const firstName = safeFirstName(input.contactName);
    const greeting = firstName === null ? 'Perfeito!' : `Perfeito, ${firstName}!`;
    return {
      matched: true,
      kind: 'party_size',
      reason: 'party_size_exact',
      response: `${greeting} Para ${partySize} pessoas, vocês estão pensando mais em salgados, doces ou uma combinação dos dois? 😊`,
      llmCallsBeforeSend: 0,
      partySize,
    };
  }

  const simple = classifySimpleSales(text);
  if (simple === null) return noMatch('not_safe_simple_sales');
  const response = validateCommercialResponse(renderSimpleSales(simple, input.history), input.history)
    ? renderSimpleSales(simple, input.history)
    : 'Perfeito! Anotei essa informação. 😊';
  return {
    matched: true,
    kind: 'simple_sales',
    reason: `simple_sales_${simple}`,
    response,
    llmCallsBeforeSend: 0,
    partySize: null,
  };
}

export function validateCommercialResponse(
  response: string,
  history: FoodserviceHistoryMessage[],
): boolean {
  if (/quer\s+que\s+eu\s+(?:sugira|indique|ajude)/i.test(response)) return false;
  if (/posso\s+te\s+(?:ajudar|indicar|sugerir)/i.test(response)) return false;
  if (/se\s+quiser,?\s+posso/i.test(response)) return false;
  if ((response.match(/\?/g) ?? []).length > 1) return false;
  if (URL_RE.test(response)) return false;

  const prior = history.map((message) => message.body).join('\n');
  if (PARTY_QUESTION_RE.test(response) && history.some((message) => extractPartySize(message.body) !== null)) {
    return false;
  }
  if (/qual\s+data|para\s+quando/i.test(response) && DATE_RE.test(prior)) return false;
  if (/salgados,?\s+doces|combina[cç][aã]o\s+dos\s+dois/i.test(response) && PREFERENCE_RE.test(prior)) {
    return false;
  }
  return true;
}

export function hasRecentCommercialContext(
  history: FoodserviceHistoryMessage[],
  now: Date,
): boolean {
  const cutoff = now.getTime() - 48 * 60 * 60 * 1000;
  return history.some((message) => {
    const at = new Date(message.sentAt).getTime();
    return Number.isFinite(at) && at >= cutoff && (COMMERCIAL_RE.test(message.body) || PARTY_QUESTION_RE.test(message.body));
  });
}

type SimpleSalesKind = 'category' | 'both' | 'date' | 'assent' | 'decline' | 'flavor';

function classifySimpleSales(text: string): SimpleSalesKind | null {
  const normalized = normalize(text);
  if (/^(?:eu\s+)?(?:prefiro|quero)\s+salgados?$/.test(normalized)) return 'category';
  if (/^(?:eu\s+)?(?:prefiro|quero)\s+doces?$/.test(normalized)) return 'category';
  if (/^(?:eu\s+)?(?:prefiro|quero)\s+chocolate$/.test(normalized)) return 'flavor';
  if (/^(?:os\s+dois|quero\s+os\s+dois)$/.test(normalized)) return 'both';
  if (/^(?:e\s+)?(?:e|vai\s+ser)\s+(?:para|pra)\s+amanha$/.test(normalized)) return 'date';
  if (/^(?:sim,?\s*)?(?:pode\s+ser|perfeito|isso)$/.test(normalized)) return 'assent';
  if (/^(?:nao,?\s*)?(?:so\s+isso|obrigad[oa])$/.test(normalized)) return 'decline';
  return null;
}

function renderSimpleSales(kind: SimpleSalesKind, history: FoodserviceHistoryMessage[]): string {
  const prior = history.map((message) => message.body).join('\n');
  const partyKnown = history.some((message) => extractPartySize(message.body) !== null);
  const dateKnown = DATE_RE.test(prior);
  const preferenceKnown = PREFERENCE_RE.test(prior);

  switch (kind) {
    case 'decline':
      return 'Tudo certo! 😊';
    case 'date':
      return preferenceKnown
        ? 'Perfeito! Vocês preferem retirar ou receber por entrega? 😊'
        : 'Perfeito! Vocês preferem salgados, doces ou uma combinação dos dois? 😊';
    case 'both':
      return 'Perfeito! Vocês preferem uma divisão meio a meio entre salgados e doces? 😊';
    case 'category':
    case 'flavor':
      return partyKnown
        ? dateKnown
          ? 'Perfeito! Vocês preferem retirar ou receber por entrega? 😊'
          : 'Perfeito! Para qual data vocês precisam? 😊'
        : 'Perfeito! Para quantas pessoas será? 😊';
    case 'assent':
      return dateKnown
        ? 'Perfeito! Vocês preferem retirar ou receber por entrega? 😊'
        : 'Perfeito! Para qual data vocês precisam? 😊';
  }
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function safeFirstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0] ?? '';
  return /^[\p{L}][\p{L}'-]{1,30}$/u.test(first) ? first : null;
}

function noMatch(reason: string): FoodserviceFastPathDecision {
  return { matched: false, kind: null, reason, llmCallsBeforeSend: 0 };
}

/**
 * O Render entrega enderecos internos como `host:porta` via `fromService`.
 * `fetch` e o Zod do worker exigem uma URL absoluta. No Docker Compose
 * continuamos recebendo `http://waha:3000`, entao os dois formatos precisam
 * permanecer validos.
 */
export function normalizeWahaBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

import { sarahSettingsSchema } from "./schema";

export function buildSarahMemoryContent(data: ReturnType<typeof sarahSettingsSchema.parse>): string {
  const fields = [
    ["Mensagem inicial", data.greeting],
    ["Regras importantes", data.rules],
    ["Orientações comerciais", data.commercial_guidance],
    ["Produtos prioritários", data.priority_products],
    ["Orientação de venda adicional", data.upsell_guidance],
    ["Quando chamar uma pessoa", data.handoff_guidance],
  ] as const;
  return `Nome de atendimento: ${data.name}\n\n${fields
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}:\n${value.trim()}`)
    .join("\n\n")}`;
}

export function isSarahMemoryPublished(
  settings: unknown,
  pointerVersionId: string | null | undefined,
  recordedVersionId: unknown,
  publishedContent: unknown,
): boolean {
  const parsed = sarahSettingsSchema.safeParse(settings);
  return parsed.success
    && Boolean(pointerVersionId)
    && recordedVersionId === pointerVersionId
    && typeof publishedContent === "string"
    && publishedContent === buildSarahMemoryContent(parsed.data);
}

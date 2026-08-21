export function isAuthorizedProspectingCron(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const provided = bearer || request.headers.get("x-cron-secret")?.trim() || "";
  const accepted = [process.env.CRON_SECRET, process.env.INTERNAL_CRON_SECRET, process.env.INTERNAL_SECRET]
    .map((v) => (v ?? "").trim()).filter(Boolean);
  return accepted.length > 0 && provided.length > 0 && accepted.includes(provided);
}

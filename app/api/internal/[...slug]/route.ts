/**
 * Catch-all 404 para /api/internal/*. Endpoints internos legítimos vivem em
 * rotas específicas (ex.: agents/run); qualquer outro caminho é desconhecido
 * e deve devolver 404 JSON em vez de cair no fallback HTML do App Router.
 */
import { fail } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function notFound(): Response {
  return fail("not_found", "unknown /api/internal/* path", 404);
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;

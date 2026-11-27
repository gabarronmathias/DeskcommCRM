"use client";
/**
 * ImpersonateBanner (S-11.07) — sticky amber banner shown at the top of /app/*
 * when the platform admin holds an active impersonate cookie.
 *
 * Server-side, `app/app/layout.tsx` reads & verifies the cookie and passes the
 * tenant identity through `impersonating`. This component renders nothing if
 * the prop is null, so it is safe to mount unconditionally inside the layout.
 *
 * "Sair" calls POST /api/v1/admin/impersonate/end which deletes the cookie,
 * then we navigate the admin back to the tenant detail page in /admin.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export interface ImpersonatingInfo {
  tenantId: string;
  tenantName: string;
  expiresAt: string; // ISO-8601
  mode?: "read_only_preview";
}

interface Props {
  impersonating: ImpersonatingInfo | null;
}

export function ImpersonateBanner({ impersonating }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!impersonating) return null;

  async function handleEnd() {
    if (!impersonating) return;
    setBusy(true);
    try {
      const res = await fetch("/api/v1/admin/impersonate/end", {
        method: "POST",
      });
      if (!res.ok) {
        toast.error("Falha ao encerrar impersonate");
        return;
      }
      // Hard navigation so the cleared cookie takes effect on next request.
      window.location.assign(`/admin/tenants/${impersonating.tenantId}`);
      router.push(`/admin/tenants/${impersonating.tenantId}`);
    } catch (err) {
      toast.error("Erro de rede ao encerrar impersonate");
      console.error("[impersonate] end error", err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="sticky top-0 z-50 flex items-center justify-between gap-4 border-b border-amber-300 bg-amber-100/95 px-4 py-2 text-sm text-amber-950 backdrop-blur dark:border-amber-700/60 dark:bg-amber-950/70 dark:text-amber-50"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>🛡️</span>
        <span>
          {impersonating.mode === "read_only_preview"
            ? "PREVIEW ADMINISTRATIVO — tenant em onboarding, somente leitura: "
            : "Modo Impersonate — atuando como "}
          <strong className="font-semibold">{impersonating.tenantName}</strong>
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="border-amber-400 bg-white/60 text-amber-950 hover:bg-white dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-50 dark:hover:bg-amber-900/70"
        onClick={handleEnd}
        disabled={busy}
        aria-label="Encerrar impersonate e voltar ao admin"
      >
        {busy ? "Encerrando…" : "Sair"}
      </Button>
    </div>
  );
}

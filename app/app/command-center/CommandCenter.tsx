"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface Snapshot {
  timestamp: string;
  org: { id: string; slug: string; name: string };
  services: Record<string, string>;
  env: {
    enabled: boolean;
    outboundEnabled: boolean;
    dryRun: boolean;
    campaign: string;
    dailyLimit: number;
    businessHourStart: number;
    businessHourEnd: number;
    isWithinBusinessHours: boolean;
    timezone: string;
  };
  queue: {
    totals: Record<string, number>;
    recent: Array<{
      id: string;
      status: string;
      kind: string;
      lead_id: string;
      scheduled_for: string | null;
      error_code: string | null;
      error_message: string | null;
      sent_at: string | null;
      crm_message_id: string | null;
      updated_at: string;
      metadata: { company?: string; campaign?: string; city?: string; category?: string } | null;
    }>;
  };
  whatsapp: {
    session: { name: string; status: string; me_id: string | null; me_pushname: string | null } | null;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    lastInboundBody: string | null;
    lastOutboundExternalId: string | null;
  };
  runs: Array<{
    id: string;
    event_type: string;
    entity_kind: string;
    entity_id: string | null;
    payload: Record<string, unknown> | null;
    severity: string | null;
    created_at: string;
  }>;
  alerts: Array<{ level: "warn" | "critical"; code: string; message: string; since: string }>;
}

function statusColor(value: string | undefined): string {
  const v = (value ?? "").toLowerCase();
  if (v === "online" || v === "working" || v === "running" || v === "configured" || v === "ready") return "bg-emerald-500";
  if (v === "degraded" || v === "idle" || v === "skipped" || v === "warn") return "bg-amber-500";
  if (v === "offline" || v === "failed" || v === "stopped" || v === "error" || v === "not_configured") return "bg-red-500";
  return "bg-slate-400";
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.floor((now - t) / 1000);
  if (sec < 60) return `há ${sec}s`;
  if (sec < 3600) return `há ${Math.floor(sec / 60)}min`;
  if (sec < 86400) return `há ${Math.floor(sec / 3600)}h`;
  return `há ${Math.floor(sec / 86400)}d`;
}

export function CommandCenter({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastFetchedAt = useRef<string | null>(null);

  const fetchSnap = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/command-center/snapshot", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      setSnap(json.data);
      setError(null);
      lastFetchedAt.current = json.data?.timestamp ?? new Date().toISOString();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetchSnap();
    const t = setInterval(() => {
      if (!paused) fetchSnap();
    }, 10_000);
    return () => clearInterval(t);
  }, [fetchSnap, paused]);

  const control = async (path: string) => {
    setBusy(true);
    try {
      const r = await fetch(path, { method: "POST" });
      const json = await r.json();
      if (!r.ok) {
        setError(json?.error?.message ?? `HTTP ${r.status}`);
      } else {
        setError(null);
        await fetchSnap();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const emergencyStop = async () => {
    if (!confirm("PARAR operação? Isso pausa envios e outbound, mas NAO mata CRM nem queue.")) return;
    await control("/api/v1/command-center/emergency-stop");
  };

  return (
    <div className="flex h-full flex-col gap-4 p-4 lg:p-6">
      {/* HEADER */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
            AO VIVO
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">GB Command Center</h1>
          <p className="text-sm text-muted-foreground">
            {orgName} · última atualização {snap ? relativeTime(snap.timestamp) : "—"}
            {error ? ` · erro: ${error}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:border-accent"
            disabled={busy}
          >
            {paused ? "Retomar auto-refresh" : "Pausar auto-refresh"}
          </button>
          <button
            type="button"
            onClick={emergencyStop}
            className="rounded-md border border-red-600 bg-red-600/10 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-600/20"
            disabled={busy}
          >
            PARAR OPERAÇÃO
          </button>
        </div>
      </header>

      {/* ALERTAS */}
      {snap && snap.alerts.length > 0 ? (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold uppercase tracking-wider text-amber-700">Alertas</div>
          <ul className="mt-2 space-y-1">
            {snap.alerts.map((a, i) => (
              <li key={i}>
                <span className="font-mono text-xs">[{a.level}]</span> {a.message}{" "}
                <span className="text-xs text-amber-700">({a.code})</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* STATUS GERAIS */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Status dos serviços</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { k: "Hermes", v: snap?.services["hermes"] },
            { k: "Sarah WhatsApp", v: snap?.services["waha"] },
            { k: "Sarah Voice", v: snap?.services["voice"] },
            { k: "WAHA", v: snap?.whatsapp?.session?.status },
            { k: "CRM / Supabase", v: snap?.services["supabase"] },
            { k: "Database", v: snap?.services["supabase"] },
          ].map((s) => (
            <div key={s.k} className="rounded-md border border-border bg-surface p-3 text-xs">
              <div className="text-muted-foreground">{s.k}</div>
              <div className="mt-1 flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${statusColor(s.v)}`} />
                <span className="font-mono text-sm font-semibold uppercase">{s.v ?? "—"}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* PROSPECÇÃO CONFIG + TOTAIS */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Prospecção hoje</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-11">
          {[
            { k: "Encontrados", v: snap ? Object.values(snap.queue.totals).reduce((a, b) => a + b, 0) : null },
            { k: "Na fila", v: snap?.queue.totals["pending"] },
            { k: "Enviados", v: snap?.queue.totals["sent"] },
            { k: "Entregues", v: snap?.queue.totals["delivered"] },
            { k: "Lidos", v: snap?.queue.totals["read"] },
            { k: "Respondidos", v: snap?.queue.totals["replied"] },
            { k: "Cancelados", v: snap?.queue.totals["cancelled"] },
            { k: "Falhos", v: snap?.queue.totals["failed"] },
            { k: "Opt-outs", v: snap?.queue.totals["opt_out"] },
            { k: "Handoff", v: snap?.queue.totals["handoff"] },
            { k: "Follow-ups", v: snap?.queue.totals["followup_pending"] },
          ].map((m) => (
            <div key={m.k} className="rounded-md border border-border bg-surface p-3 text-center">
              <div className="text-2xl font-semibold tabular-nums">{m.v ?? "—"}</div>
              <div className="text-xs text-muted-foreground">{m.k}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            campanha: <span className="font-mono text-foreground">{snap?.env.campaign ?? "—"}</span>
          </span>
          <span>·</span>
          <span>
            limite diário: <span className="font-mono text-foreground">{snap?.env.dailyLimit ?? "—"}</span>
          </span>
          <span>·</span>
          <span>
            janela: <span className="font-mono text-foreground">{snap?.env.businessHourStart}–{snap?.env.businessHourEnd}</span>
          </span>
          <span>·</span>
          <span>
            outbound: <span className="font-mono text-foreground">{snap?.env.outboundEnabled ? "ON" : "OFF"}</span>
          </span>
          <span>·</span>
          <span>
            dry-run: <span className="font-mono text-foreground">{snap?.env.dryRun ? "SIM" : "NÃO"}</span>
          </span>
          <span>·</span>
          <span>
            em janela: <span className="font-mono text-foreground">{snap?.env.isWithinBusinessHours ? "SIM" : "NÃO"}</span>
          </span>
        </div>
      </section>

      {/* FILA AO VIVO */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Fila de prospecção (ao vivo)</h2>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Tipo</th>
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Categoria</th>
                <th className="px-3 py-2">Cidade</th>
                <th className="px-3 py-2">Agendado</th>
                <th className="px-3 py-2">Enviado</th>
                <th className="px-3 py-2">Erro</th>
              </tr>
            </thead>
            <tbody>
              {snap?.queue.recent.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase ${statusBg(r.status)}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">{r.kind}</td>
                  <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{r.lead_id?.slice(0, 8)}…</td>
                  <td className="px-3 py-2">{r.metadata?.category ?? "—"}</td>
                  <td className="px-3 py-2">{r.metadata?.city ?? "—"}</td>
                  <td className="px-3 py-2">{r.scheduled_for ? relativeTime(r.scheduled_for) : "—"}</td>
                  <td className="px-3 py-2">{r.sent_at ? relativeTime(r.sent_at) : "—"}</td>
                  <td className="px-3 py-2 text-red-700">{r.error_code ?? ""}</td>
                </tr>
              ))}
              {snap && snap.queue.recent.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-muted-foreground" colSpan={8}>
                    Fila vazia.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* WHATSAPP */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Sarah WhatsApp</h2>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="rounded-md border border-border bg-surface p-3 text-xs">
            <div className="text-muted-foreground">Sessão WAHA</div>
            <div className="mt-1 font-mono text-sm">{snap?.whatsapp.session?.name ?? "—"}</div>
            <div className="mt-2 text-muted-foreground">Status</div>
            <div className="mt-1 flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${statusColor(snap?.whatsapp.session?.status)}`} />
              <span className="font-mono text-sm font-semibold uppercase">{snap?.whatsapp.session?.status ?? "—"}</span>
            </div>
            <div className="mt-2 text-muted-foreground">me_id</div>
            <div className="mt-1 font-mono text-[11px]">{snap?.whatsapp.session?.me_id ?? "—"}</div>
            <div className="mt-2 text-muted-foreground">me_pushname</div>
            <div className="mt-1 font-mono text-[11px]">{snap?.whatsapp.session?.me_pushname ?? "—"}</div>
          </div>
          <div className="rounded-md border border-border bg-surface p-3 text-xs">
            <div className="text-muted-foreground">Última mensagem recebida</div>
            <div className="mt-1 text-foreground">{snap?.whatsapp.lastInboundBody ?? "—"}</div>
            <div className="mt-1 text-muted-foreground">{snap?.whatsapp.lastInboundAt ? relativeTime(snap.whatsapp.lastInboundAt) : "—"}</div>
          </div>
          <div className="rounded-md border border-border bg-surface p-3 text-xs">
            <div className="text-muted-foreground">Última mensagem enviada</div>
            <div className="mt-1 font-mono text-[11px]">WAHA id: {snap?.whatsapp.lastOutboundExternalId ?? "—"}</div>
            <div className="mt-1 text-muted-foreground">{snap?.whatsapp.lastOutboundAt ? relativeTime(snap.whatsapp.lastOutboundAt) : "—"}</div>
          </div>
        </div>
      </section>

      {/* TIMELINE */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Atividade da operação (timeline)</h2>
        <div className="rounded-md border border-border bg-surface p-3">
          <ul className="space-y-1 text-xs">
            {snap?.runs.slice(0, 20).map((e) => (
              <li key={e.id} className="flex items-start gap-2">
                <span className="font-mono text-[10px] text-muted-foreground">{new Date(e.created_at).toLocaleTimeString("pt-BR")}</span>
                <span className="font-mono text-[10px] text-muted-foreground">[{e.severity ?? "info"}]</span>
                <span className="font-mono text-[10px]">{e.event_type}</span>
                <span className="text-muted-foreground">· {e.entity_kind}</span>
                {e.payload && Object.keys(e.payload).length > 0 ? (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    · {Object.entries(e.payload).slice(0, 3).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
            {snap && snap.runs.length === 0 ? (
              <li className="text-muted-foreground">Sem eventos recentes.</li>
            ) : null}
          </ul>
        </div>
      </section>

      {/* CONTROLES */}
      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Controles</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => control("/api/v1/command-center/pause-prospecting")}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:border-accent"
            disabled={busy}
          >
            Pausar prospecção
          </button>
          <button
            type="button"
            onClick={() => control("/api/v1/command-center/resume-prospecting")}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:border-accent"
            disabled={busy}
          >
            Retomar prospecção
          </button>
          <button
            type="button"
            onClick={() => control("/api/v1/command-center/pause-outbound")}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:border-accent"
            disabled={busy}
          >
            Pausar outbound
          </button>
          <button
            type="button"
            onClick={() => control("/api/v1/command-center/resume-outbound")}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:border-accent"
            disabled={busy}
          >
            Retomar outbound
          </button>
        </div>
      </section>
    </div>
  );
}

function statusBg(s: string): string {
  const v = (s ?? "").toLowerCase();
  if (v === "pending") return "bg-slate-200 text-slate-800";
  if (v === "sent" || v === "delivered") return "bg-emerald-100 text-emerald-800";
  if (v === "read" || v === "replied") return "bg-sky-100 text-sky-800";
  if (v === "cancelled" || v === "failed") return "bg-red-100 text-red-800";
  if (v === "held") return "bg-amber-100 text-amber-800";
  if (v === "handoff") return "bg-violet-100 text-violet-800";
  if (v === "opt_out") return "bg-zinc-200 text-zinc-800";
  if (v === "followup_pending") return "bg-indigo-100 text-indigo-800";
  return "bg-slate-100 text-slate-700";
}

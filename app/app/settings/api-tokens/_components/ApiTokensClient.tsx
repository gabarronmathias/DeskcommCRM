"use client";
import { useState } from "react";
import { toast } from "sonner";

import {
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
  type CreatedApiToken,
} from "@/hooks/team/useApiTokens";
import { copyToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * `mcp:read`/`mcp:write` faltavam nesta lista, e sem eles NENHUMA ferramenta
 * MCP funciona: toda chamada volta "Token missing required scope 'mcp:read'"
 * (lib/mcp/types.ts exige um dos dois em cada tool). Como esta tela é o único
 * lugar que emite token, o "CRM operável por agentes de IA via MCP" ficava
 * inalcançável — a API sempre aceitou os escopos; só o catálogo daqui os
 * escondia.
 */
const SCOPES: { id: string; label: string }[] = [
  { id: "mcp:read", label: "Agentes de IA podem chamar tools MCP de leitura (exige escopos do domínio)" },
  { id: "mcp:write", label: "Agentes de IA podem chamar tools MCP de escrita (exige escopos do domínio)" },
  // Opcional e sensível: eleva o token acima do default `agent`.
  // Não usar para integrações comerciais limitadas; prefira escopos granulares.
  { id: "role:manager", label: "Tratar o token como gerente (necessário p/ configuração)" },
  { id: "contacts:read", label: "Ler contatos" },
  { id: "contacts:write", label: "Criar e editar contatos" },
  { id: "leads:read", label: "Ler leads" },
  { id: "lead_risk:read", label: "Ler radar de leads em risco" },
  { id: "leads:write", label: "Criar e editar leads" },
  { id: "messages:read", label: "Ler conversas e histórico de mensagens" },
  { id: "messages:write", label: "Enviar mensagens" },
  { id: "audit:read", label: "Ler o log de auditoria" },
  { id: "pipelines:read", label: "Ler pipelines e stages" },
  { id: "followups:read", label: "Ler follow-ups" },
  { id: "automations:read", label: "Ler automações" },
  { id: "webhooks:read", label: "Ler webhooks e eventos" },
  { id: "team:read", label: "Ler membros da equipe" },
  { id: "knowledge:read", label: "Ler acervo de conhecimento" },
  { id: "org_memory:read", label: "Ler memória organizacional" },
  { id: "privacy:read", label: "Ler pedidos de privacidade/LGPD" },
  { id: "orders:read", label: "Ler pedidos" },
  { id: "products:read", label: "Ler produtos" },
  { id: "tags:read", label: "Ler tags" },
  { id: "templates:read", label: "Ler respostas prontas/templates" },
  { id: "queue:read", label: "Ler status da fila" },
  { id: "handoff:read", label: "Ler casos humanos e atendentes" },
  { id: "followups:write", label: "Agendar/cancelar follow-ups" },
  { id: "automations:write", label: "Ativar/desativar automações" },
  { id: "webhooks:write", label: "Criar/ativar webhooks" },
  { id: "pipelines:write", label: "Alterar pipelines/stages" },
  { id: "handoff:write", label: "Fazer handoff/atribuição de atendimento" },
  { id: "tags:write", label: "Alterar tags" },
  { id: "org_memory:write", label: "Alterar memória organizacional" },
];

export function ApiTokensClient() {
  const { data, isLoading } = useApiTokens();
  const create = useCreateApiToken();
  const revoke = useRevokeApiToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<string>("");
  const [created, setCreated] = useState<CreatedApiToken | null>(null);

  const tokens = data?.data ?? [];

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (scopes.length === 0) {
      toast.error("Selecione ao menos um escopo.");
      return;
    }
    try {
      const res = await create.mutateAsync({
        name,
        scopes,
        expires_in_days: expiresInDays ? Number(expiresInDays) : undefined,
      });
      setCreated(res.data);
      setName("");
      setScopes([]);
      setExpiresInDays("");
      setCreateOpen(false);
    } catch {
      /* noop */
    }
  };

  const toggleScope = (s: string) => {
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>Criar token</Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum token criado ainda.</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Prefixo</TableHead>
                <TableHead>Escopos</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expira</TableHead>
                <TableHead className="w-[120px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>
                    <code className="text-xs">{t.prefix}…</code>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {t.scopes.map((s) => (
                        <Badge key={s} variant="secondary" className="text-xs">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {t.revoked_at ? (
                      <Badge variant="destructive">Revogado</Badge>
                    ) : (
                      <Badge variant="default">Ativo</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {t.expires_at ? new Date(t.expires_at).toLocaleDateString("pt-BR") : "—"}
                  </TableCell>
                  <TableCell>
                    {!t.revoked_at ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={async () => {
                          await revoke.mutateAsync(t.id);
                          toast.success("Token revogado.");
                        }}
                      >
                        Revogar
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Criar novo token</DialogTitle>
            <DialogDescription>O plaintext será mostrado apenas uma vez.</DialogDescription>
          </DialogHeader>
          <form onSubmit={onCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="t-name">Nome</Label>
              <Input
                id="t-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Worker de import"
                minLength={2}
                maxLength={100}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Escopos</Label>
              <div className="flex flex-wrap gap-2">
                {SCOPES.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => toggleScope(s.id)}
                    title={s.label}
                    aria-label={`${s.id} — ${s.label}`}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      scopes.includes(s.id) ? "border-primary bg-primary/10" : "border-border"
                    }`}
                  >
                    {s.id}
                    <span className="ml-1 text-muted-foreground">· {s.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-exp">Expira em (dias) — opcional</Label>
              <Input
                id="t-exp"
                type="number"
                min={1}
                max={365}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="365"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={create.isPending}>
                Criar
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!created} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Token criado</DialogTitle>
            <DialogDescription>
              Copie e guarde agora — não conseguiremos exibir novamente.
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="space-y-3">
              <code className="block break-all rounded-md border bg-muted p-3 text-sm">
                {created.plaintext}
              </code>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void copyToClipboard(created.plaintext).then((ok) => {
                    if (ok) toast.success("Token copiado.");
                    else toast.error("Não foi possível copiar — selecione o token acima.");
                  });
                }}
              >
                Copiar para clipboard
              </Button>
              <p className="text-xs text-muted-foreground">{created._warning}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

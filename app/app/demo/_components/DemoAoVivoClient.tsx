"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ApiError } from "@/lib/api/types";
import { apiClient } from "@/lib/api/client";
import {
  channelLabel,
  useChannelSessions,
  type ChannelSession,
} from "@/hooks/channels/useChannelSessions";
import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import {
  useConversationsRealtime,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import {
  ArrowRight,
  ArrowsClockwise,
  ChartLineUp,
  Check,
  CheckCircle,
  CircleNotch,
  Copy,
  Gauge,
  Inbox,
  Kanban,
  MonitorPlay,
  Phone,
  PlugsConnected,
  QrCode,
  Robot,
  Warning,
  X,
} from "@/lib/ui/icons";

const MENSAGEM_DE_TESTE = "Olá, quero fazer um pedido";

type DemoStep = "canal" | "mensagem" | "atendimento" | "crm";

function textoDoErro(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

function telefoneParaLink(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}

function nomeDoContato(conversation: ConversationWithContact | undefined): string {
  return (
    conversation?.contacts?.display_name ||
    conversation?.contacts?.name ||
    conversation?.contacts?.phone_number ||
    "Novo contato"
  );
}

function horaDaMensagem(iso: string | null | undefined): string {
  if (!iso) return "agora";
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function StepDot({ done, active }: { done: boolean; active: boolean }) {
  return (
    <span
      className={[
        "relative z-10 grid size-11 place-items-center rounded-full border-4 border-background transition-colors",
        done
          ? "bg-success text-white"
          : active
            ? "bg-accent text-accent-foreground"
            : "bg-surface-elevated text-text-muted",
      ].join(" ")}
      aria-hidden
    >
      {done ? (
        <Check size={18} weight="bold" />
      ) : (
        <span className="size-2 rounded-full bg-current" />
      )}
      {active && !done ? (
        <span className="bg-accent/25 absolute inset-0 -z-10 animate-ping rounded-full motion-reduce:animate-none" />
      ) : null}
    </span>
  );
}

function FlowStep({
  label,
  detail,
  done,
  active,
}: {
  label: string;
  detail: string;
  done: boolean;
  active: boolean;
}) {
  return (
    <div className="flex items-start gap-3 md:flex-col md:items-center md:text-center">
      <StepDot done={done} active={active} />
      <div className="pt-1 md:pt-0">
        <p className="text-sm font-semibold text-text">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{detail}</p>
      </div>
    </div>
  );
}

export function DemoAoVivoClient({
  organizationId,
  organizationName,
  wahaConfigured,
  wakeUrls,
}: {
  organizationId: string;
  organizationName: string;
  wahaConfigured: boolean;
  wakeUrls: string[];
}) {
  const channels = useChannelSessions({ refetchInterval: 3_000 });
  const counts = useConversationCounts(organizationId, { refetchInterval: 5_000 });
  const conversations = useConversationsRealtime({ exclude_finished: true }, organizationId);

  const [pairingId, setPairingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [qrTick, setQrTick] = useState(0);
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [presentationMode, setPresentationMode] = useState(false);

  useEffect(() => {
    // Os servicos gratuitos do Render dormem quando ficam ociosos. Uma chamada
    // sem credenciais basta para acorda-los antes de o apresentador gerar o QR.
    for (const url of wakeUrls) {
      void fetch(url, { cache: "no-store", mode: "no-cors" }).catch(() => undefined);
    }
  }, [wakeUrls]);

  const sessions = channels.data ?? [];
  const connected = sessions.find((session) => session.status === "WORKING");
  const waitingForQr = sessions.find(
    (session) => session.waha_session_name && session.status === "SCAN_QR_CODE",
  );
  const pairingSession = pairingId
    ? sessions.find((session) => session.id === pairingId)
    : waitingForQr;

  const recent = useMemo(
    () => conversations.data?.pages.flatMap((page) => page.data) ?? [],
    [conversations.data],
  );
  const latestConversation = recent[0];
  const inboundAt = latestConversation?.last_inbound_at
    ? new Date(latestConversation.last_inbound_at).getTime()
    : 0;
  const receivedDuringDemo = armedAt !== null && inboundAt >= armedAt;

  const activeStep: DemoStep = !connected
    ? "canal"
    : !receivedDuringDemo
      ? "mensagem"
      : latestConversation
        ? "atendimento"
        : "crm";

  useEffect(() => {
    if (!pairingId || pairingSession?.status !== "SCAN_QR_CODE") return;
    const timer = window.setInterval(() => setQrTick((tick) => tick + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [pairingId, pairingSession?.status]);

  useEffect(() => {
    if (!pairingId || pairingSession?.status !== "WORKING") return;
    toast.success("WhatsApp conectado. A demonstração já pode começar.");
  }, [pairingId, pairingSession?.status]);

  useEffect(() => {
    const onFullscreenChange = () => setPresentationMode(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  async function connectWhatsApp() {
    if (waitingForQr) {
      setPairingId(waitingForQr.id);
      setArmedAt(Date.now());
      return;
    }

    setCreating(true);
    try {
      const result = await apiClient.post<{ data: ChannelSession }>("/api/v1/channel-sessions", {});
      setPairingId(result.data.id);
      setArmedAt(Date.now());
    } catch (error) {
      toast.error(textoDoErro(error, "Não foi possível gerar o QR do WhatsApp."));
    } finally {
      setCreating(false);
    }
  }

  async function copyTestMessage() {
    try {
      await navigator.clipboard.writeText(MENSAGEM_DE_TESTE);
      toast.success("Mensagem de teste copiada.");
    } catch {
      toast.error("Não foi possível copiar. Digite a mensagem mostrada na tela.");
    }
  }

  async function togglePresentationMode() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      setPresentationMode((value) => !value);
    }
  }

  const businessPhone = telefoneParaLink(connected?.phone_number);
  const whatsappTestUrl = businessPhone
    ? `https://wa.me/${businessPhone}?text=${encodeURIComponent(MENSAGEM_DE_TESTE)}`
    : null;

  return (
    <div
      className={[
        "mx-auto flex w-full max-w-[1480px] flex-col gap-6",
        presentationMode
          ? "fixed inset-0 z-[80] max-w-none overflow-y-auto bg-background p-5 md:p-8"
          : "p-2 md:p-6",
      ].join(" ")}
      data-testid="demo-ao-vivo"
    >
      <header className="flex flex-col gap-5 border-b border-border pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge variant="success">
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              Demonstração ao vivo
            </Badge>
            <span className="text-xs text-text-muted">{organizationName}</span>
          </div>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-[-0.035em] text-text md:text-5xl">
            Do primeiro “oi” ao próximo passo, na frente do cliente.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted md:text-base">
            Conecte um número, peça uma mensagem real e mostre atendimento, contexto e CRM se
            atualizando na mesma operação.
          </p>
        </div>
        <Button variant="outline" onClick={() => void togglePresentationMode()}>
          {presentationMode ? <X /> : <MonitorPlay />}
          {presentationMode ? "Sair da apresentação" : "Modo apresentação"}
        </Button>
      </header>

      <section
        aria-label="Progresso da demonstração"
        className="relative rounded-xl border border-border bg-surface p-5 md:p-7"
      >
        <div
          className="absolute left-[12.5%] right-[12.5%] top-[49px] hidden h-px bg-border md:block"
          aria-hidden
        />
        <div
          className="absolute left-[12.5%] top-[49px] hidden h-px bg-accent transition-[width] duration-500 md:block"
          style={{
            width: connected ? (receivedDuringDemo ? "75%" : "25%") : "0%",
          }}
          aria-hidden
        />
        <div className="relative grid gap-5 md:grid-cols-4 md:gap-8">
          <FlowStep
            label="Canal"
            detail={connected ? "Número conectado" : "Aguardando QR"}
            done={Boolean(connected)}
            active={activeStep === "canal"}
          />
          <FlowStep
            label="Mensagem"
            detail={receivedDuringDemo ? "Entrada detectada" : "Envie o primeiro oi"}
            done={receivedDuringDemo}
            active={activeStep === "mensagem"}
          />
          <FlowStep
            label="Atendimento"
            detail={receivedDuringDemo ? "Conversa visível" : "Inbox em escuta"}
            done={receivedDuringDemo && Boolean(latestConversation)}
            active={activeStep === "atendimento"}
          />
          <FlowStep
            label="CRM"
            detail="Contexto e próximo passo"
            done={false}
            active={activeStep === "crm"}
          />
        </div>
      </section>

      <main className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
        <div className="grid gap-6">
          <Card className="overflow-hidden">
            <div className="grid md:grid-cols-[180px_minmax(0,1fr)]">
              <div className="flex flex-col justify-between bg-accent-soft p-6">
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
                  Passo 1
                </span>
                <QrCode className="mt-8 size-14 text-accent" weight="duotone" aria-hidden />
              </div>
              <div className="p-6 md:p-8">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold tracking-tight text-text">
                      Conecte o WhatsApp
                    </h2>
                    <p className="mt-1 text-sm text-text-muted">
                      O QR nasce aqui e o status muda sozinho quando o aparelho conecta.
                    </p>
                  </div>
                  {channels.isLoading ? (
                    <Badge variant="neutral">
                      <CircleNotch className="animate-spin motion-reduce:animate-none" />{" "}
                      Verificando
                    </Badge>
                  ) : connected ? (
                    <Badge variant="success">
                      <CheckCircle /> Conectado
                    </Badge>
                  ) : (
                    <Badge variant="warning">
                      <Warning /> Pendente
                    </Badge>
                  )}
                </div>

                {!wahaConfigured ? (
                  <div className="mt-6 rounded-lg border border-warning bg-warning-bg p-4 text-sm text-warning-fg">
                    <p className="font-semibold">
                      O serviço de WhatsApp ainda não está configurado.
                    </p>
                    <p className="mt-1 leading-relaxed">
                      Abra Conexões para conferir o endereço e a chave do serviço antes da reunião.
                    </p>
                    <Button asChild variant="outline" size="sm" className="mt-4">
                      <Link href="/app/connections">
                        Abrir conexões <ArrowRight />
                      </Link>
                    </Button>
                  </div>
                ) : connected ? (
                  <div className="border-success/25 mt-6 flex flex-col gap-4 rounded-lg border bg-success-bg p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3">
                      <span className="grid size-11 place-items-center rounded-full bg-success text-white">
                        <Phone />
                      </span>
                      <div>
                        <p className="font-semibold text-success-fg">{channelLabel(connected)}</p>
                        <p className="text-success-fg/80 text-xs">
                          Pronto para receber a mensagem do prospect
                        </p>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setArmedAt(Date.now())}>
                      <ArrowsClockwise /> Reiniciar escuta
                    </Button>
                  </div>
                ) : pairingSession ? (
                  <div className="mt-6 grid gap-5 rounded-lg border border-border bg-surface-elevated p-5 sm:grid-cols-[220px_1fr] sm:items-center">
                    {pairingSession.status === "SCAN_QR_CODE" ? (
                      <div className="rounded-lg bg-white p-3 shadow-xs">
                        {/* O endpoint protegido entrega o QR atual; ele expira e o tick renova a URL. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/v1/channel-sessions/${pairingSession.id}/qr?t=${qrTick}`}
                          alt="QR Code para conectar o WhatsApp"
                          className="aspect-square w-full"
                        />
                      </div>
                    ) : (
                      <div className="grid aspect-square place-items-center rounded-lg border border-dashed border-border bg-surface">
                        <CircleNotch className="size-9 animate-spin text-accent motion-reduce:animate-none" />
                      </div>
                    )}
                    <div>
                      <p className="font-semibold text-text">
                        {pairingSession.status === "SCAN_QR_CODE"
                          ? "Escaneie com o celular"
                          : "Preparando o QR"}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-text-muted">
                        No WhatsApp: <strong>Aparelhos conectados</strong> →{" "}
                        <strong>Conectar um aparelho</strong>. Esta tela confirma a conexão
                        automaticamente.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <Button
                      disabled={creating || channels.isError}
                      onClick={() => void connectWhatsApp()}
                    >
                      {creating ? (
                        <CircleNotch className="animate-spin motion-reduce:animate-none" />
                      ) : (
                        <QrCode />
                      )}
                      Gerar QR agora
                    </Button>
                    <Button asChild variant="ghost">
                      <Link href="/app/connections">Gerenciar números</Link>
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="grid md:grid-cols-[180px_minmax(0,1fr)]">
              <div className="flex flex-col justify-between bg-info-bg p-6">
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-info-fg">
                  Passo 2
                </span>
                <Robot className="mt-8 size-14 text-info-fg" weight="duotone" aria-hidden />
              </div>
              <div className="p-6 md:p-8">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold tracking-tight text-text">
                      Provoque o atendimento
                    </h2>
                    <p className="mt-1 text-sm text-text-muted">
                      Peça ao prospect para enviar exatamente esta mensagem.
                    </p>
                  </div>
                  {receivedDuringDemo ? (
                    <Badge variant="success">
                      <CheckCircle /> Recebida às{" "}
                      {horaDaMensagem(latestConversation?.last_inbound_at)}
                    </Badge>
                  ) : armedAt ? (
                    <Badge variant="info">
                      <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />{" "}
                      Escutando ao vivo
                    </Badge>
                  ) : (
                    <Badge variant="neutral">Aguardando o passo 1</Badge>
                  )}
                </div>

                <blockquote className="mt-6 border-l-4 border-accent pl-5 text-2xl font-medium tracking-tight text-text md:text-3xl">
                  “{MENSAGEM_DE_TESTE}”
                </blockquote>

                <div className="mt-6 flex flex-wrap gap-3">
                  <Button variant="outline" onClick={() => void copyTestMessage()}>
                    <Copy /> Copiar mensagem
                  </Button>
                  {whatsappTestUrl ? (
                    <Button asChild>
                      <a href={whatsappTestUrl} target="_blank" rel="noreferrer">
                        <Phone /> Abrir no WhatsApp
                      </a>
                    </Button>
                  ) : null}
                  {connected && !armedAt ? (
                    <Button onClick={() => setArmedAt(Date.now())}>
                      <PlugsConnected /> Iniciar escuta
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </Card>
        </div>

        <aside className="grid content-start gap-6">
          <Card className="p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                  Sinal ao vivo
                </p>
                <h2 className="mt-1 text-lg font-semibold text-text">Central de atendimento</h2>
              </div>
              <span className="relative flex size-3" aria-hidden>
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-50 motion-reduce:animate-none" />
                <span className="relative inline-flex size-3 rounded-full bg-success" />
              </span>
            </div>

            {conversations.isLoading ? (
              <div className="mt-8 flex items-center gap-2 text-sm text-text-muted">
                <CircleNotch className="animate-spin motion-reduce:animate-none" /> Lendo a operação
              </div>
            ) : latestConversation ? (
              <div className="mt-6 rounded-lg border border-border bg-surface-elevated p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-text">{nomeDoContato(latestConversation)}</p>
                    <p className="mt-1 line-clamp-2 text-sm leading-5 text-text-muted">
                      {latestConversation.last_message_preview || "Conversa iniciada"}
                    </p>
                  </div>
                  <Badge variant={receivedDuringDemo ? "success" : "neutral"}>
                    {receivedDuringDemo
                      ? "Agora"
                      : horaDaMensagem(latestConversation.last_message_at)}
                  </Badge>
                </div>
                <Button asChild className="mt-5 w-full">
                  <Link href={`/app/inbox?id=${latestConversation.id}`}>
                    <Inbox /> Abrir atendimento recebido
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="mt-6 rounded-lg border border-dashed border-border p-6 text-center">
                <Inbox className="mx-auto size-8 text-text-muted" aria-hidden />
                <p className="mt-3 text-sm font-medium text-text">
                  A primeira conversa aparecerá aqui
                </p>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  Esta área usa a mesma fonte em tempo real da Inbox.
                </p>
              </div>
            )}

            <div className="mt-5 grid grid-cols-3 gap-2">
              {[
                ["Fila", counts.data?.unassigned ?? 0],
                ["Comigo", counts.data?.mine ?? 0],
                ["Visíveis", counts.data?.all ?? 0],
              ].map(([label, value]) => (
                <div key={label} className="rounded-md bg-surface-elevated px-2 py-3 text-center">
                  <p className="text-xl font-semibold tabular-nums text-text">{value}</p>
                  <p className="text-[11px] text-text-muted">{label}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">
              Passo 3
            </p>
            <h2 className="mt-1 text-lg font-semibold text-text">Mostre o sistema trabalhando</h2>
            <p className="mt-2 text-sm leading-6 text-text-muted">
              Abra as telas na ordem da conversa: primeiro o atendimento, depois o negócio e por fim
              o que não pode morrer.
            </p>
            <nav className="mt-5 grid gap-2" aria-label="Atalhos da demonstração">
              {[
                {
                  href: "/app/inbox",
                  icon: Inbox,
                  label: "1. Atendimento",
                  detail: "IA e humano lado a lado",
                },
                {
                  href: "/app/kanban",
                  icon: Kanban,
                  label: "2. CRM",
                  detail: "Dono, etapa e contexto",
                },
                {
                  href: "/app/radar",
                  icon: Gauge,
                  label: "3. Próximo passo",
                  detail: "Nada morre no silêncio",
                },
                {
                  href: "/app/metrics",
                  icon: ChartLineUp,
                  label: "4. Resultado",
                  detail: "Operação mensurável",
                },
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="grid size-9 place-items-center rounded-md bg-surface-elevated text-text-muted group-hover:text-accent">
                    <item.icon />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-text">{item.label}</span>
                    <span className="block truncate text-xs text-text-muted">{item.detail}</span>
                  </span>
                  <ArrowRight className="text-text-muted group-hover:text-accent" />
                </Link>
              ))}
            </nav>
          </Card>

          <div className="rounded-xl border border-dashed border-border px-5 py-4 text-xs leading-5 text-text-muted">
            <strong className="text-text">Plano B:</strong> se a rede externa oscilar, abra uma
            conversa já existente e siga pelos mesmos quatro atalhos. A demonstração continua
            honesta: o sistema mostra o que está ao vivo e o que depende do canal.
          </div>
        </aside>
      </main>
    </div>
  );
}

/**
 * MCP special tool — crm_request_human_handoff v2 (Spec 11 §3.3 + G6-01).
 *
 * Side effects (todos via `triggerHandoff` orchestrator + assignment best-effort):
 *   - conversations.status='pending', bot_silenced_until='infinity'
 *   - crm_lead_activities INSERT (type='handoff_triggered') quando há lead vinculado
 *   - event_log INSERT event_type='ai.handoff_triggered'
 *   - Realtime broadcast `org:<org>:queue` event=handoff_pending
 *   - api_audit_log action='ai.handoff_triggered' (+ mcp.tool_called no server core)
 *
 * v2 (G6-01 / INB-12): a ESCOLHA do destino usa o roteamento G5 — UM algoritmo:
 *   - `target_user_id` opcional: se passado E elegível agora (disponível ∧ horário
 *     ∧ folga), atribui a ele;
 *   - senão, rodízio real `selectRoundRobin` sobre os elegíveis (mesma lógica do
 *     worker de roteamento — o antigo pickRoundRobinAssignee random foi removido);
 *   - sem ninguém elegível → fila (fallback), retornando a posição.
 *   Retorno estruturado: { assigned_to } OU { queued: true, position }.
 *   Efeitos auditados (assignment event reason='handoff') preservados nos dois casos.
 */
import { z } from "zod";

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { loadEligibleAttendants } from "@/lib/routing/eligibles";
import { selectRoundRobin } from "@/lib/routing/decide";
import { getQueuePosition } from "@/lib/routing/queue";
import { logger } from "@/lib/logger";
import type { McpToolDefinition } from "../types";

const inputShape = {
  conversation_id: z.string().uuid(),
  reason: z.string().min(1).max(500).default("requested_human"),
  urgency: z.enum(["low", "normal", "high"]).default("normal"),
  /** Atendente alvo opcional: só atribui se elegível agora; senão cai no rodízio G5. */
  target_user_id: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const crmRequestHumanHandoff: McpToolDefinition<typeof inputShape> = {
  name: "crm_request_human_handoff",
  description:
    "Aciona handoff bot→humano. Marca a conversa como pending, silencia o bot e escolhe o " +
    "destino pelo roteamento G5: atende o target_user_id se elegível agora, senão rodízio " +
    "entre os disponíveis; sem ninguém elegível vai para a fila. Registra activity + " +
    "event_log + audit. Retorna assigned_to OU queued+position. Use quando o cliente pedir " +
    "atendente humano ou o agente identificar limite da automação.",
  inputSchema: inputShape,
  category: "handoff",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // Conversation must belong to org (defense in depth — service role bypassa RLS).
    const { data: conv, error: convErr } = await ctx.supabase
      .from("conversations")
      .select("id, organization_id, contact_id, last_inbound_at")
      .eq("id", input.conversation_id)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conv || conv.organization_id !== ctx.organizationId) {
      throw new Error("conversation_not_found");
    }

    // Try to find a lead linked to this contact (best effort for activity insert).
    let leadId: string | null = null;
    if (conv.contact_id) {
      const { data: leadRow } = await ctx.supabase
        .from("crm_leads")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .eq("contact_id", conv.contact_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      leadId = leadRow?.id ?? null;
    }

    const result = await triggerHandoff({
      conversationId: input.conversation_id,
      organizationId: ctx.organizationId,
      reason: "requested_human",
      leadId,
      metadata: {
        source: "ai_agent",
        urgency: input.urgency,
        original_reason: input.reason,
        ...(ctx.actor.type === "ai_agent" ? { run_id: ctx.actor.id } : {}),
        ...(input.metadata ?? {}),
      },
    });

    let assignedUserId: string | null = null;
    let queued = false;
    let position: number | null = null;

    if (result.triggered) {
      const now = new Date();
      // INB-12: mesmos elegíveis do worker de roteamento (G5) — um algoritmo só.
      const eligibles = await loadEligibleAttendants(ctx.supabase, ctx.organizationId, now);
      const picked =
        input.target_user_id && eligibles.some((e) => e.userId === input.target_user_id)
          ? input.target_user_id
          : selectRoundRobin(eligibles);

      if (picked) {
        // G3-02: reassignment auditado — UPDATE (kind ai→'user') + evento
        // reason='handoff' na MESMA transação (fn_conversation_assign, 0031/0032).
        const { data: rows, error: assignErr } = await ctx.supabase.rpc("fn_conversation_assign", {
          p_organization_id: ctx.organizationId,
          p_conversation_id: input.conversation_id,
          p_to_user_id: picked,
          p_reason: "handoff",
          p_enforce_expected: false,
        });
        if (assignErr || !Array.isArray(rows) || rows.length === 0) {
          logger.warn("[mcp.handoff] assignment failed", {
            conversation_id: input.conversation_id,
            error: assignErr?.message ?? "0 rows (conversation not found)",
          });
        } else {
          assignedUserId = picked;
        }
      }

      if (!assignedUserId) {
        // Fila (roteamento G5 sem elegível): sem dono, kind sai de 'ai' → null; o
        // handoff continua auditado (evento reason='handoff', from/to null).
        const { error: kindErr } = await ctx.supabase
          .from("conversations")
          .update({ assignee_kind: null })
          .eq("id", input.conversation_id)
          .eq("organization_id", ctx.organizationId);
        if (kindErr) {
          logger.warn("[mcp.handoff] assignee_kind clear failed", {
            conversation_id: input.conversation_id,
            error: kindErr.message,
          });
        }
        const { error: eventErr } = await ctx.supabase
          .from("conversation_assignment_events")
          .insert({
            organization_id: ctx.organizationId,
            conversation_id: input.conversation_id,
            from_user_id: null,
            to_user_id: null,
            changed_by: null,
            reason: "handoff",
          });
        if (eventErr) {
          logger.warn("[mcp.handoff] handoff event insert failed", {
            conversation_id: input.conversation_id,
            error: eventErr.message,
          });
        }
        queued = true;
        position = await getQueuePosition(
          ctx.supabase,
          ctx.organizationId,
          conv.last_inbound_at ?? null,
          now,
        );
      }
    }

    return {
      handoff_recorded: result.triggered,
      conversation_id: input.conversation_id,
      // Retorno estruturado v2: um destes dois lados é populado.
      assigned_to: assignedUserId,
      queued,
      position,
      // Compat com o contrato anterior (callers que liam assigned_to_user_id).
      assigned_to_user_id: assignedUserId,
      idempotent: !result.triggered && result.reason === "idempotent_5s",
      next_action:
        "Avise o cliente em tom acolhedor que um atendente humano vai assumir em instantes.",
    };
  },
};

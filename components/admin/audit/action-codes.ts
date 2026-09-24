/**
 * Flat list of all known audit action codes — mirrors AuditAction in
 * lib/audit/actions.ts. Used in the AuditFiltersAdmin multi-select.
 * Keep in sync manually when new actions are appended.
 */
export const ACTION_CODES: string[] = [
  "auth.login_success",
  "auth.login_failed",
  "auth.logout",
  "auth.mfa_enrolled",
  "auth.mfa_success",
  "auth.mfa_failed",
  "auth.recovery_code_used",
  "nuvemshop.connected",
  "nuvemshop.disconnected",
  "nuvemshop.oauth_failed",
  "nuvemshop.webhook_received",
  "nuvemshop.webhook_invalid_signature",
  "lead.created",
  "lead.updated",
  "lead.deleted",
  "lead.moved",
  "lead.won",
  "lead.lost",
  "lead.bulk_action",
  "contact.created",
  "contact.updated",
  "contact.anonymized",
  "contact.merge_pending",
  "contact.merged",
  "lgpd.anonymize_executed",
  "member.invited",
  "member.accepted",
  "member.role_changed",
  "member.revoked",
  "token.created",
  "token.revoked",
  "profile.updated",
  "org.updated",
  "pipeline.config_updated",
  "mfa.recovery_codes_regenerated",
  "notification_prefs.changed",
  "onboarding.welcome_completed",
  "onboarding.whatsapp_configured",
  "onboarding.whatsapp_skipped",
  "onboarding.nuvemshop_skipped",
  "onboarding.ai_configured",
  // O passo que troca o quadro de e-commerce semeado por um do ramo do negócio,
  // e o passo de ver o funcionário responder antes de terminar o wizard.
  "onboarding.quadro_montado",
  "onboarding.quadro_pulado",
  "onboarding.agente_testado",
  "onboarding.agente_teste_pulado",
  "onboarding.team_invited",
  "onboarding.completed",
  "tenant.onboarded",
  // A verificação em duas etapas deixou de ser imposta por papel: quem exige, e
  // quem desligou a própria, é escolha auditável.
  "security.mfa_exigida",
  "security.mfa_dispensada",
  "security.mfa_desativada",
  // O signup que RECUSOU provisionar empresa nova porque o convite não valia —
  // sem esta linha, o caso mais delicado do fluxo de convite não teria filtro.
  "auth.signup_provision_recusado",
  "conversation.created",
  "conversation.claimed",
  "conversation.released",
  "conversation.closed",
  "message.sent",
  "message.received",
  "contact.blocked",
  "ai.handoff_triggered",
  "ai.reactivated_by_agent",
  "ai.case_noted_by_agent",
  "ai.case_closed_by_agent",
  "conversation.usable_for_rag_toggled",
  "rag.conversations_batch_run",
  "lgpd.redact_received",
  "lgpd.data_request_received",
  "lgpd.store_redact_received",
  "lgpd.export_generated",
  "lgpd.export_delivered",
  "lgpd.export_failed",
  "lgpd.redact_executed",
  "lgpd.redact_skipped_already_anonymized",
  "lgpd.redact_no_local_footprint",
  "lgpd.redact_completed",
  "lgpd.redact_failed",
  "lgpd.tenant_redacted",
  "lgpd.consent_changed",
  "lgpd.manually_approved",
  "webhook.hmac_invalid",
  "lgpd.sla_alarm_triggered",
  "lgpd.sla_watcher_run",
  "platform_admin.inbox_listed",
  "platform_admin.conversation_viewed",
  "platform_admin.tenants_listed",
  "platform_admin.tenant_viewed",
  "tenant.created_by_platform_admin",
  "platform_admin.tenant_health_viewed",
  "platform_admin.impersonate_started",
  "platform_admin.impersonate_ended",
  "platform_admin.impersonate_misconfigured",
  "tenant.suspended",
  "tenant.reactivated",
  "platform_admin.audit_listed",
  "platform_admin.audit_entry_viewed",
  "athos.launch.created",
  "orders.read.history",
  // Marca da instalação trocada (migration 0155). Entra aqui E em
  // lib/audit/actions.ts — sem isto o filtro do painel não oferece o código e a
  // linha existiria no banco sem porta na tela.
  //
  // ⚠️ ACHADO, NÃO CONSERTADO AQUI: estas duas listas JÁ DIVERGEM. Medido em
  // 2026-08-13, com esta entrada JÁ nas duas — 208 códigos no union de
  // `lib/audit/actions.ts` contra 88 aqui, e 120 que existem, são emitidos e NÃO
  // são filtráveis no painel (o inverso é 0: nada aqui falta lá). O comentário do
  // topo diz "keep in sync manually" e não há gate nenhum cobrando — foi assim
  // que 120 entradas se perderam. Curar 120 entradas alheias dentro
  // desta mudança misturaria duas coisas e esconderia as duas; a dívida está
  // registrada no handoff desta frente para virar item próprio (o conserto certo
  // é derivar esta lista do union, não copiá-la melhor).
  "platform_branding.updated",
  "org.branding_updated",
];

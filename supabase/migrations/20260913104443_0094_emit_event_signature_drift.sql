-- Migration 0094: reconcile emit_event signature drift
--
-- PRODUCTION DRIFT (observado no WhatsApp real — segundo turno Sarah):
--   POST /api/v1/webhooks/waha/[token] retorna 503 com:
--     "Could not find the function public.emit_event(
--        p_entity_kind, p_event_type, p_metadata,
--        p_organization_id, p_payload
--      ) in the schema cache"
--
-- O repo (baseline.sql:69 + migration 0093) define a versão canônica com 6
-- parâmetros incluindo `p_entity_id`. Mas o banco de produção tem uma
-- versão antiga com 5 parâmetros (sem `p_entity_id`) e ordem diferente.
-- Isso faz o `admin.rpc("emit_event", {...})` falhar com 404 da PostgREST.
--
-- Esta migration reconcilia o banco para a versão canônica do repo. Idempotente:
-- pode ser aplicada várias vezes sem efeito colateral.
--
-- O QUE NÃO MUDA:
--   - Comportamento do `emit_event` em si (mesmo body SQL).
--   - Permissões (security definer; grants ficam intactos).
--   - Outras funções (fn_emit_event_on_lead_change, fn_emit_channel_session_status_changed).
--
-- APLICAR APENAS NO BANCO QUE APRESENTA O ERRO. NÃO mexer em produção sem
-- revisão (regra dura de migrations — doutrina no CLAUDE.md).

CREATE OR REPLACE FUNCTION "public"."emit_event"(
  "p_event_type" "text",
  "p_entity_kind" "text",
  "p_entity_id" "uuid",
  "p_payload" "jsonb" DEFAULT '{}'::"jsonb",
  "p_metadata" "jsonb" DEFAULT '{}'::"jsonb",
  "p_organization_id" "uuid" DEFAULT NULL::"uuid"
) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.event_log (
    id, event_type, entity_kind, entity_id, payload, metadata, organization_id, occurred_at
  ) values (
    v_id, p_event_type, p_entity_kind, p_entity_id,
    coalesce(p_payload, '{}'::jsonb),
    coalesce(p_metadata, '{}'::jsonb),
    p_organization_id,
    now()
  )
  on conflict (organization_id, entity_kind, entity_id, event_type, occurred_at)
    where organization_id is not null
    do nothing;
  return v_id;
end;
$$;

ALTER FUNCTION "public"."emit_event"(
  "p_event_type" "text",
  "p_entity_kind" "text",
  "p_entity_id" "uuid",
  "p_payload" "jsonb",
  "p_metadata" "jsonb",
  "p_organization_id" "uuid"
) OWNER TO "postgres";

-- Idempotência do schema cache do PostgREST (regra do PostgREST: ele
-- detecta a nova assinatura automaticamente via NOTIFY pgrst após
-- ALTER FUNCTION, mas se a aplicação estiver em retry-loop há horas, o
-- cache local pode estar stale). O `NOTIFY pgrst, 'reload schema'` força
-- reload imediato. Esta linha é idempotente e inócua se o cache já
-- estiver atualizado.
NOTIFY pgrst, 'reload schema';

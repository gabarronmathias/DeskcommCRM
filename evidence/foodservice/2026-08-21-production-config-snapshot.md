# Snapshot de configuração — Gabarron & Mathias

Capturado em 2026-08-21 antes das alterações da missão de prospecção foodservice.

Este snapshot não contém credenciais, chaves, tokens, telefones completos ou dados de prospects.

- Supabase de produção: `ukenluaihqiuwtdssatc`
- Organização: `gabarron-mathias`
- `organization_id`: `6c5b6e18-e03e-4db0-acd2-305b5f8bb1a9`
- Branding tenant-scoped: ausente (`organizations.settings.branding = null`)
- Pipeline: `Oportunidades Comerciais`
- Pipeline ID: `609a2b37-c974-42e3-b62a-1c449e53bf6b`
- Etapas: Novo Lead; Sarah Atendendo; Lead Qualificado; Reunião Agendada; Diagnóstico Realizado; Proposta Enviada; Follow-up / Negociação; Fechado / Ganho; Perdido / Reativação
- Sarah ID: `dd8314a7-1491-47d7-8813-53c11046860f`
- Versão publicada preservada para rollback: v7 (`d478b823-dc97-4b86-9b7b-439e4cbcd138`)
- Channel session publicada: `5d47d745-0a47-4530-ae8e-ca137144bb8a`
- Estado observado das sessões WhatsApp GB: `STOPPED`
- Bindings em `ai_purpose_bindings`: nenhum para esta organização
- Provider/model informado pelo responsável como runtime válido: Qwen, com fallback OpenAI
- Fluxos de follow-up existentes preservados: Campanhas na base; Follow-up de proposta; Reativação de leads; Recuperação de oportunidade

Política de rollback: a versão publicada v7 é imutável e não será editada. Alterações da Sarah serão feitas por nova versão; branding será aplicado por merge em `organizations.settings`, sem substituir outras chaves.

## Estado depois das alterações seguras

- Migration `foodservice_prospecting_queue` aplicada no Supabase de produção.
- Fila criada vazia: zero prospects, zero mensagens e zero registros de outros tenants.
- EXECUTE do claim negado a `anon` e `authenticated`; somente `service_role` opera a fila.
- Branding GB gravado como `{ "app_name": "Gabarron & Mathias" }`; logo não gravado porque o arquivo físico ainda não existe.
- Sarah v8 criada como `draft`, com `alibaba/qwen-flash`, channel e pipeline preservados, prompt de prospecção e 13 tools reais do catálogo.
- Sarah v7 continua publicada: a v8 não foi publicada porque a organização GB ainda não possui credenciais Alibaba nem OpenAI próprias no banco.
- WhatsApp GB continua `STOPPED`; outbound continua desabilitado e nenhum envio real foi tentado.

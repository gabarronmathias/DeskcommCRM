import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

const ORG = "f00d0000-0000-4000-8000-000000000001";
const PIPE = "f00d0000-0000-4000-8000-000000000002";
const STAGE = "f00d0000-0000-4000-8000-000000000003";
const SESSION = "f00d0000-0000-4000-8000-000000000004";
const CONTACT = "f00d0000-0000-4000-8000-000000000005";
const CONVERSATION = "f00d0000-0000-4000-8000-000000000006";
const LEAD = "f00d0000-0000-4000-8000-000000000007";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, display_name, legal_name)
    values ('${ORG}', 'prospecting-test', 'Prospecting Test', 'Prospecting Test') on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug, is_default)
    values ('${PIPE}', '${ORG}', 'Oportunidades Comerciais', 'oportunidades-comerciais', false) on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
    values ('${STAGE}', '${ORG}', '${PIPE}', 'Novo Lead', 'novo-lead', 1) on conflict do nothing;
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
    values ('${SESSION}', '${ORG}', 'prospecting-test', decode('00','hex'), 'WORKING') on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name, phone_number, tags)
    values ('${CONTACT}', '${ORG}', 'Padaria Teste', '+5512999990000', array['prospeccao','foodservice']) on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
    values ('${CONVERSATION}', '${ORG}', '${CONTACT}', '${SESSION}', 'ai_handling') on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, source, source_metadata)
    values ('${LEAD}', '${ORG}', '${PIPE}', '${STAGE}', '${CONTACT}', 'Padaria Teste', 'google_places', '{"google_place_id":"place-test"}') on conflict do nothing;
  `);
});

function enqueue(key: string, kind = "opening") {
  return sql(`insert into public.prospecting_outbound_queue
    (organization_id, lead_id, contact_id, conversation_id, channel_session_id, kind, message_body, idempotency_key)
    values ('${ORG}','${LEAD}','${CONTACT}','${CONVERSATION}','${SESSION}','${kind}','teste','${key}') returning id;`);
}

describe("fila de prospecção", () => {
  it("deduplica a abertura no banco", () => {
    enqueue("opening:place-test");
    let error = "";
    try { enqueue("opening:place-test"); } catch (err) { error = motivoDoErro(err); }
    expect(error).toContain("duplicate key");
  });

  it("claim só alcança a organização pedida", () => {
    const claimed = lastLine(sql(`select count(*) from public.fn_claim_prospecting_outbound('${ORG}', 1);`));
    expect(claimed).toBe("1");
  });

  it("inbound cancela o follow-up D+2", () => {
    enqueue("followup48h:place-test", "followup");
    sql(`insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body)
      values ('${ORG}','${CONVERSATION}','${SESSION}','${CONTACT}','text','inbound','received','Como funciona?');`);
    const status = lastLine(sql(`select status from public.prospecting_outbound_queue where organization_id='${ORG}' and idempotency_key='followup48h:place-test';`));
    expect(status).toBe("cancelled");
    const activity = lastLine(sql(`select count(*) from public.crm_lead_activities where organization_id='${ORG}' and lead_id='${LEAD}' and type='prospecting_reply_received';`));
    expect(activity).toBe("1");
  });

  it("opt-out cancela toda a fila e adiciona nao-contatar", () => {
    enqueue("opening:after-stop");
    sql(`update public.contacts set is_blocked=true where organization_id='${ORG}' and id='${CONTACT}';`);
    const result = lastLine(sql(`select (status='cancelled')::text || ':' || ('nao-contatar'=any(c.tags))::text
      from public.prospecting_outbound_queue q join public.contacts c on c.id=q.contact_id
      where q.organization_id='${ORG}' and q.idempotency_key='opening:after-stop';`));
    expect(result).toBe("true:true");
    const activity = lastLine(sql(`select count(*) from public.crm_lead_activities where organization_id='${ORG}' and lead_id='${LEAD}' and type='prospecting_opt_out';`));
    expect(activity).toBe("1");
  });
});

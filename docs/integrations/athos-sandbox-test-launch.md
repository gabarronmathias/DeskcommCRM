# Athos sandbox: launch de homologação sem WhatsApp

`POST /api/v1/partners/athos/test-launch` gera uma correlação de teste no CRM.
Não envia mensagem nem cria pedido. A rota exige o Bearer da integração Athos
com escopo `athos:events:write`; somente integrações ativas em `sandbox` são
aceitas. O `store_ref` deve coincidir com o da integração vinculada ao token.

```http
POST /api/v1/partners/athos/test-launch
Authorization: Bearer <token Athos>
Content-Type: application/json

{"store_ref":"5b7b4a38-4c54-488e-986f-9ea0428cff7a"}
```

Resposta `201`:

```json
{
  "data": {
    "environment": "sandbox",
    "launch_id": "<uuid>",
    "crm_contact_id": "<uuid>",
    "crm_conversation_id": null,
    "store_ref": "5b7b4a38-4c54-488e-986f-9ea0428cff7a",
    "expires_at": "<ISO-8601 UTC>"
  }
}
```

O contato criado é sintético, marcado como teste e bloqueado para mensagens.
O lançamento vale por 10 minutos; a rota aceita no máximo 10 chamadas por
token/hora (`429` com `Retry-After` caso ultrapasse). Consulte o lançamento em
`GET /api/v1/partners/athos/launches/{launch_id}`. Para testar `POST
/api/v1/partners/athos/events`, use o `launch_id` e `crm_contact_id` recebidos,
timestamp Unix de até cinco minutos e a assinatura HMAC sobre o corpo exato.
O evento de pedido altera o CRM e, portanto, só deve ser enviado como teste
deliberado de homologação.


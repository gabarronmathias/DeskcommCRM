# Onboarding e smoke test de um novo tenant

Use um contato e um número de WhatsApp exclusivos de homologação. Nunca execute opt-out num
contato real de cliente.

## Antes da mensagem

- [ ] Tenant criado e ativo; nenhum identificador foi copiado de outra organização.
- [ ] Agente publicado e vinculado à sessão de WhatsApp correta.
- [ ] Provider e modelo acessíveis com a credencial da organização.
- [ ] Catálogo/cardápio da própria organização publicado e acessível em janela anônima.
- [ ] Canal `WORKING`, webhook configurado e worker `healthy`.
- [ ] `bash scripts/production/healthcheck.sh` termina com código zero.
- [ ] O Compose efetivo usa apenas `docker-compose.prod.yml` e, se aplicável, o override oficial
  de proxy; nenhum arquivo de ajuste temporário está na linha de comando.

## Fluxos dourados no WhatsApp real

Registre horário, `messages.id` do inbound, texto recebido e latência. Para cada linha, aguarde a
resposta antes de enviar a próxima.

| Fluxo | Entrada | Resultado esperado |
|---|---|---|
| Saudação | `Olá` | Uma resposta, sem duplicação tardia |
| Catálogo | pedido explícito de cardápio | Link pertencente ao tenant testado |
| Quantidade | `somos em 6 pessoas` após contexto comercial | Uma pergunta comercial, zero LLM no fast path |
| Preferência | `prefiro salgados` | Nova resposta curta, sem repetir quantidade |
| Handoff | pedido explícito de atendente | Fast path não intercepta; fluxo normal de humano |

Para cada inbound simples, valide a persistência e o exactly-once:

```bash
bash scripts/production/smoke-test.sh \
  --tenant-id <uuid-do-tenant> \
  --inbound-message-id <uuid-da-mensagem>
```

- [ ] `inbound=1`, `response_ledger=1`, `outbound=1`.
- [ ] Nenhuma segunda resposta aparece após dois minutos sem novo inbound.
- [ ] Logs contêm `foodservice_fast_path` sem conteúdo da mensagem ou outro dado pessoal.
- [ ] Mensagem nova do mesmo contato recebe resposta nova.
- [ ] `pnpm test:golden` passa no commit implantado.

## Critério de aprovação

O tenant só sai da homologação quando todos os fluxos acima passam, o link pertence ao próprio
tenant, não há resposta duplicada e rollback para a versão anterior está anotado.

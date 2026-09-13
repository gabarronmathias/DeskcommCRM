# Sarah Production V1 — release candidate homologada

## Baseline e escopo

- Baseline funcional: `8004b3011a65f29cf55338d8d97a5de00e69ff3a`.
- Branch de homologação: `fix/sarah-turn-continuity`.
- Tag desta consolidação operacional: `sarah-production-v1.0.0-rc.1`.
- A tag `vX.Y.Z` pública só deve nascer depois do porte seletivo para a `main` e de todos os gates.
- Esta consolidação não altera regras comerciais, prompts, schema, provider, modelo ou credenciais.

## Auditoria de genealogia

O destino operacional desta branch é `gabarronmathias/main`. O intervalo
`gabarronmathias/main..8004b301` contém 26 commits (25 lineares e um merge) e foi auditado por
assunto e arquivos. A `main` do fork é ancestral da baseline, mas 10 desses commits não pertencem
à release da Sarah; por isso o fast-forward integral também é proibido.

A `origin/main` canônica foi auditada separadamente no mesmo corte. Ela havia divergido da
baseline: 174 commits exclusivos do lado da baseline e 1.788 do lado canônico, com merge-base
`782931d745a6430cc495d6368c87f24af11b3fe8`. Não se deve tentar resolver essa distância dentro
desta release.

Os 16 commits que formam a mudança homologada e devem ser portados, na ordem, são:

1. `84db5802c41903c0ce17254bbf9c15200d04559a` — redução segura de egress do worker ocioso.
2. `08540a3d2c984b3360aa7fcd1b2ee89f51f8c7a3` — degradação segura sem Redis.
3. `3250173ce17714dfc0ccaacee30b8a916f4c507c` — criação da sessão antes do webhook.
4. `2346311851b1dcdcb9f4d96240445609a75b0464` — reinício da sessão após atualizar webhook.
5. `982dfe1da3e7ac1c8d0492b9aab960421653ab48` — continuidade inbound sem daemon auxiliar.
6. `2637254b3aeb9c3de6d7352a67bb0a0dd71e6280` — retry seguro de mensagens enfileiradas.
7. `1fd985d4d5ad860d841b853559818a1dbf749e05` — segurança de build do retry.
8. `2d832d8af00f0736b45e3c3284f2b4cd58d2020c` — compatibilidade com variáveis Redis da Vercel.
9. `b3bef8025ea1c89502a26b1ec6e2815777f621b4` — bypass de router vazio.
10. `a1e5717f64d8971dd98481e9a7ba60d94a7c7e84` — fast-skip determinístico de promessa.
11. `aa968ec42a0f242001ac586135663afce34811a5` — fast lane do classificador de estágio.
12. `e78bee75496ea71a6d3f9fd7ca61f6c8d379b6e1` — perfil rápido de contexto.
13. `44c02edbce53af5cc1f619d5eac2df18cc33b08b` — regressões do classificador de promessa.
14. `6ca014c999f8fd3a61c02d0e09dbfc4840f6d36d` — correção da prova negativa e orçamento de tokens.
15. `1dfd1ee199fe1dc8207347ae50fb40f74ad4646f` — normalização do prefixo do provider OpenAI.
16. `8004b3011a65f29cf55338d8d97a5de00e69ff3a` — exactly-once por inbound e fast path comercial.

Commits próximos que foram auditados e deliberadamente não pertencem ao porte:

- `2d6ef86f`, `7afb7a16`: stack e scripts locais de prospecção.
- `308cdac4`: navegação específica de workspace, outra feature.
- `9d5a1bfe`: commit operacional vazio.
- `1e3a0884`: follow-ups de prospecção na Vercel, outro fluxo.
- `9e42ee0d`: merge estrutural; seu segundo pai já é a `main` do fork.
- `5ca877ca`: integração de histórico de pedidos, outra feature.
- `41ece892`: script diagnóstico temporário; removido nesta consolidação.
- `cad811ff`: limpeza de conflito preexistente em outra rota; reavaliar diretamente na `main`.
- `17199edb`: draft específico de uma organização; removido nesta consolidação.

## Plano de consolidação em main

1. Atualizar `origin/main` e criar uma branch nova a partir dela.
2. Portar somente os 16 commits acima, em ordem, preferencialmente com `cherry-pick -n` para
   resolver incompatibilidades contra a arquitetura atual sem preservar dependências acidentais.
3. Portar o commit de productionization que acompanha esta documentação.
4. Confirmar que o diff não contém migrations, prompts publicados, dados de tenant, rotas debug,
   integrações de pedidos ou arquivos de override temporário.
5. Rodar typecheck, golden tests, unitários focados, validação do Compose e build das três imagens.
6. Abrir PR contra `main`; não fazer merge enquanto a comparação mostrar arquivos fora da allowlist.
7. Depois do merge verde, criar a próxima tag normal `vX.Y.Z` a partir da `main`, aguardar as três
   imagens versionadas e só então promover o canal `stable`.

Allowlist inicial do porte: `lib/agent-engine/**`, `workers/agent-worker/main.ts`, `.env.example`,
`docker-compose.prod.yml`, `scripts/production/**`, `tests/golden/**`, testes unitários diretamente
associados e esta documentação. Qualquer arquivo fora dela exige justificativa própria no PR.

## Configuração oficial

`docker-compose.prod.yml` é a única fonte operacional do perfil homologado. O serviço `worker`
declara explicitamente os oito knobs de latência/continuidade; overlays locais não participam do
deploy, healthcheck, smoke test ou rollback.

Comandos, sempre a partir da raiz da instalação:

```bash
bash scripts/production/deploy.sh vX.Y.Z --previous vA.B.C
bash scripts/production/healthcheck.sh --expect-version X.Y.Z
bash scripts/production/smoke-test.sh --tenant-id <uuid> --inbound-message-id <uuid>
bash scripts/production/rollback.sh --to vA.B.C --confirm
```

O deploy e o rollback reutilizam o caminho oficial existente do kit, incluindo backup e checks.
Esses comandos são documentação operacional; não foram executados nesta task.

# Runbook — SaaS no Render

Este deploy transforma a instalacao self-host em uma operacao SaaS compartilhada,
sem trocar as fontes de verdade do produto. O Render executa quatro servicos; o
Supabase continua responsavel por banco, Auth, RLS, Realtime e Storage, e o
Upstash continua fornecendo Redis via REST.

## Arquitetura implantada

| Servico                 | Tipo no Render          | Funcao                                              |
| ----------------------- | ----------------------- | --------------------------------------------------- |
| `gm-delivery-saas`      | Web Service             | Next.js, API, atendimento, CRM e central de comando |
| `gm-delivery-worker`    | Background Worker       | agente de IA, fila, follow-ups e automacao ativa    |
| `gm-delivery-scheduler` | Background Worker       | dispara as rotas cron do produto                    |
| `gm-delivery-waha`      | Private Service + disco | sessoes WhatsApp, QR e webhooks                     |

O WAHA nao recebe URL publica. O browser pede o QR ao app autenticado, o app fala
com o WAHA pela rede privada e devolve apenas a imagem. O disco em
`/app/.sessions` preserva os pareamentos entre deploys e reinicios.

## Dependencias externas

Antes de criar o Blueprint, tenha:

1. um projeto Supabase com o `baseline.sql`/migrations desta versao aplicados;
2. URL REST e token de um banco Upstash Redis;
3. pelo menos uma chave de IA de plataforma (Anthropic, OpenAI ou OpenRouter),
   ou credenciais BYOK cadastradas depois pelo painel;
4. o repositorio conectado ao Render.

Render Postgres sozinho nao substitui Supabase: o produto usa tambem Auth, RLS,
Realtime e Storage. Render Key Value tambem nao substitui diretamente o Upstash,
porque o codigo atual fala com a API REST do Upstash.

## Criacao do Blueprint

1. Envie a branch homologada para o GitHub.
2. No Render, escolha **New > Blueprint** e selecione o repositorio.
3. Confirme o arquivo `render.yaml` da raiz.
4. Preencha os campos marcados como `sync: false`:

| Variavel                        | Valor                                                |
| ------------------------------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | URL do projeto Supabase                              |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key do Supabase                                 |
| `SUPABASE_SERVICE_ROLE_KEY`     | service role do Supabase                             |
| `SUPABASE_DB_URL`               | connection string direta/pooler do Postgres Supabase |
| `UPSTASH_REDIS_REST_URL`        | endpoint REST do Upstash                             |
| `UPSTASH_REDIS_REST_TOKEN`      | token REST do Upstash                                |
| `NEXT_PUBLIC_APP_URL`           | URL HTTPS final do web service                       |
| `NEXT_PUBLIC_ADMIN_URL`         | a mesma URL no primeiro deploy                       |
| `WHATSAPP_HOOK_URL`             | URL final + `/api/v1/webhooks/waha`                  |
| chaves de IA                    | preencha ao menos uma; as demais podem ficar vazias  |

Exemplo, se o Render reservar `https://gm-delivery-saas.onrender.com`:

```text
NEXT_PUBLIC_APP_URL=https://gm-delivery-saas.onrender.com
NEXT_PUBLIC_ADMIN_URL=https://gm-delivery-saas.onrender.com
WHATSAPP_HOOK_URL=https://gm-delivery-saas.onrender.com/api/v1/webhooks/waha
```

Os demais segredos sao gerados pelo proprio Render e compartilhados entre os
servicos por referencia; nenhum valor secreto fica no Git.

## Supabase Auth

Em **Authentication > URL Configuration** no Supabase:

- defina **Site URL** com a URL HTTPS do SaaS;
- adicione a mesma origem em **Redirect URLs**, incluindo o caminho de callback
  usado pelo projeto;
- ao trocar para dominio proprio, mantenha a URL `onrender.com` apenas durante a
  homologacao e depois remova o que nao for mais necessario.

## Homologacao obrigatoria

Nao liberar clientes antes de completar esta sequencia:

1. `GET /api/v1/health` responde sem dependencia `down`;
2. criar uma organizacao de teste e entrar em `/app/demo`;
3. clicar em **Gerar QR agora**, escanear e esperar `WORKING`;
4. enviar uma mensagem real e confirmar que ela entra na Inbox;
5. confirmar resposta da automacao, lead no Kanban e proximo passo no Radar;
6. reiniciar apenas `gm-delivery-waha` e provar que o numero volta sem novo QR;
7. entrar com uma segunda organizacao e provar que ela nao enxerga conversa,
   contato, lead ou sessao da primeira.

## Operacao e escala

- O Blueprint fixa todos os servicos na regiao `virginia` para manter a rede
  privada co-localizada e reduzir a latencia para o Brasil.
- O WAHA comeca no plano `standard` (2 GB) e com uma unica instancia. O disco
  persistente nao pode ser compartilhado por replicas.
- O app, worker e scheduler comecam em `starter`; subir o app para `standard` e
  o primeiro ajuste se houver pressao de memoria.
- O disco do WAHA impede deploy sem interrupcao apenas nesse servico. Durante a
  troca, o painel continua no ar e o canal pode ficar indisponivel por alguns
  segundos.
- Monitore sessoes, CPU e RAM. Ao passar da capacidade de uma instancia, divida
  sessoes entre multiplos WAHA e introduza roteamento por organizacao antes de
  escalar horizontalmente.

## Rollback

App, worker e scheduler podem voltar para um deploy anterior pelo historico do
Render. Nao apague nem recrie o disco do WAHA durante rollback. Se o problema for
somente o canal, mantenha o app no ar, reverta o WAHA e valide uma sessao de teste
antes de reabrir automacoes ativas.

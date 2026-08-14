# Runbook — demonstração gratuita no Render

Este deploy deixa o SaaS acessível sob demanda sem cobrança do Render. O app,
o worker e o WAHA usam Web Services gratuitos; Supabase continua responsável por
banco, Auth, RLS, Realtime e Storage. Nesta demo, limites e debounce usam memória.

> O plano gratuito não fica continuamente acordado. Após 15 minutos sem tráfego,
> o Render suspende o serviço e o primeiro acesso pode levar cerca de um minuto.
> A tela `/app/demo` acorda worker e WAHA automaticamente.

## Arquitetura implantada

| Serviço                      | Tipo no Render       | Função                                              |
| ---------------------------- | -------------------- | --------------------------------------------------- |
| `gm-delivery-demo-gm`        | Web Service gratuito | Next.js, API, atendimento, CRM e central de comando |
| `gm-delivery-worker-demo-gm` | Web Service gratuito | agente de IA, fila e automação ativa                |
| `gm-delivery-waha-demo-gm`   | Web Service gratuito | sessão WhatsApp, QR e webhooks                      |

O WAHA recebe URL pública porque serviços gratuitos não usam a rede privada do
Render. A API continua protegida por uma chave gerada pelo Blueprint, o dashboard
fica desativado e os webhooks são assinados. Nenhum segredo fica no Git.

O filesystem gratuito é efêmero. Depois de spin-down, restart ou deploy do WAHA,
gere e escaneie um QR novo. Para a demonstração comercial isso é intencional: o
pareamento diante do prospect faz parte do roteiro.

O scheduler de rotinas recorrentes fica fora desta demonstração. Mensagem inbound,
resposta imediata do agente, Inbox e CRM continuam disponíveis. Follow-ups agendados
entram na infraestrutura contratada depois da venda.

## Custo

| Recurso             | Plano gratuito |  Custo Render |
| ------------------- | -------------- | ------------: |
| App                 | Free           |         US$ 0 |
| Worker de automação | Free           |         US$ 0 |
| WAHA                | Free           |         US$ 0 |
| Disco               | Não usado      |         US$ 0 |
| **Total Render**    |                | **US$ 0/mês** |

Os serviços compartilham a franquia mensal gratuita do workspace. Com uso pontual
e suspensão automática, ela é adequada à demonstração; não equivale a operação
24/7. Não é necessário cadastrar cartão para este Blueprint.

Supabase pode ser usado em seu plano gratuito. A resposta de IA requer uma chave
com crédito existente ou uma opção gratuita disponível; sem
ela, Inbox, CRM, QR e atendimento humano continuam demonstráveis.

## Dependências externas

Antes de criar o Blueprint, tenha:

1. um projeto Supabase gratuito com o `baseline.sql`/migrations desta versão aplicados;
2. opcionalmente, uma chave de IA para mostrar resposta automática;
3. o repositório conectado ao Render.

Render Postgres sozinho não substitui Supabase: o produto usa também Auth, RLS,
Realtime e Storage. Render Key Value também não substitui diretamente o Upstash,
porque o código atual fala com a API REST do Upstash.

## Criação do Blueprint

1. Envie a branch homologada para o GitHub.
2. No Render, escolha **New > Blueprint** e selecione o repositório.
3. Confirme o arquivo `render.yaml` da raiz.
4. Preencha os campos marcados como `sync: false`:

| Variável                        | Valor                                                |
| ------------------------------- | ---------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | URL do projeto Supabase                              |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key do Supabase                                 |
| `SUPABASE_SERVICE_ROLE_KEY`     | service role do Supabase                             |
| `SUPABASE_DB_URL`               | connection string direta/pooler do Postgres Supabase |
| chaves de IA                    | preencha uma se quiser mostrar resposta automática   |

As URLs públicas já estão fixadas no Blueprint. Os demais segredos são gerados
pelo próprio Render e compartilhados entre os serviços por referência.

## Supabase Auth

Em **Authentication > URL Configuration** no Supabase:

- defina **Site URL** como `https://gm-delivery-demo-gm.onrender.com`;
- adicione a mesma origem em **Redirect URLs**, incluindo o callback do projeto;
- mantenha a URL `onrender.com` enquanto esta demonstração existir.

## Roteiro de homologação

1. Acesse o SaaS cerca de dois minutos antes da reunião para acordar o app.
2. Entre em `/app/demo`; essa tela acorda worker e WAHA.
3. Espere um minuto no primeiro acesso e clique em **Gerar QR agora**.
4. Escaneie o QR e aguarde o estado `WORKING`.
5. Envie uma mensagem real e confirme que ela entra na Inbox.
6. Se houver chave de IA, confirme a resposta automática e o lead no Kanban.
7. Mostre Radar, métricas e central de comando.
8. Depois de um restart do WAHA, confirme que o sistema oferece um novo QR.

## Operação gratuita

- Todos os serviços ficam na região `virginia`.
- A tela de demonstração dispara chamadas de aquecimento para worker e WAHA.
- `DEMO_FREE_TIER=true` ativa o fallback Redis em memória somente nesta demo.
- Um status `401` no aquecimento do WAHA é aceitável: a chamada já acordou o serviço.
- Use apenas uma sessão WhatsApp por vez nesta demonstração.
- Não configure monitor externo para impedir o spin-down: manter três serviços
  continuamente acordados excederia a franquia gratuita mensal.
- Ao vender, migre worker e WAHA para a arquitetura persistente contratada.

## Rollback

App e worker podem voltar para um deploy anterior pelo histórico do Render. Como o
WAHA gratuito não possui disco persistente, gere um novo QR depois de reinício,
rollback ou novo deploy.

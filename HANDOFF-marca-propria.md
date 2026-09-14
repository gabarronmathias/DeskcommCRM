# HANDOFF — Marca Própria (whitelabel)

> **LEIA ISTO ANTES DE QUALQUER COISA, EM TODA SESSÃO QUE TOCAR ESTE ÉPICO.**
> E alimente este arquivo **a cada avanço** — não no fim, não "quando der".
> Handoff atualizado depois é handoff que ninguém escreveu.

---

## Protocolo desta sessão (lei, não sugestão)

Imposto por Rafael em 2026-08-13, terceira repetição da mesma correção. Palavras dele:

> *"O Claude tem mania de assumir que só porque o código funciona em testes
> automatizados o trabalho está concluído. Mas os bugs, gaps e lacunas de
> usabilidade aparecem quando USAMOS a ferramenta, e são muitas; quando deixamos
> para consertar só no fim, gasta-se um tempo 3x maior do que o de desenvolvimento
> em investigação e correção."*

**O ciclo, sem exceção:**

```
avanço → Playwright na tela como usuário → as 5 lentes → HANDOFF atualizado → próximo avanço
```

**As 5 lentes de todo teste** (nenhuma substitui outra; teste automatizado verde cobre
parte da primeira e mais nada):

| Lente | A pergunta |
|---|---|
| **Técnica** | a peça faz o que promete? |
| **Funcional** | o fluxo completo entrega o resultado ao usuário? |
| **Fundacional** | a base aguenta — schema, RLS, migration, baseline, update de clone? |
| **Doutrinária** | respeita a lei do repo — Sistema Vivo, DIRC, migrations, tenancy? |
| **Empírica** | a experiência real é BOA? um leigo entende? está claro? |

**Âncora de arquitetura:** o público-alvo principal instala o CRM numa **VPS da
HostGator** pelo `hostgator-setup-kit/`, com **Supabase cloud**. Toda decisão se
avalia contra isso primeiro — não contra a Vercel, não contra o laptop. E a pergunta
que quase sempre é esquecida: **como isto chega a um clone que JÁ RODA e vai atualizar?**

---

## Onde estou

| | |
|---|---|
| **Worktree** | `/Users/rafaelmelgaco/G&M CRM-marca` |
| **Branch** | `feat/marca-propria`, criada de `origin/main` @ `f9abedd0` |
| **Banco** | Supabase local `127.0.0.1:54321` — **compartilhado com outras sessões**, checar antes de DDL |
| **Blueprint** | https://claude.ai/code/artifact/1aa1b097-d6f4-4aff-b388-194b1e546ca2 |

> ⚠️ O worktree principal (`/Users/rafaelmelgaco/G&M CRM`) é de **outra sessão** —
> mudou de `fix/alertas-de-seguranca-github` para `fix/issues-triadas` no meio desta.
> Não commitar lá.

---

## Estado das fases

**A ordem mudou depois da reancoragem.** A antiga fazia sentido para a Vercel, onde nada
chega ao usuário sem deploy. Sob a âncora VPS, o valor chega antes por outro caminho: o
que o comprador percebe primeiro não é upload de logo, é **a interface não parecer a
nossa** — e cor é o eixo mais barato, mais visível, e o único que a doc de venda declara
impossível hoje.

> **A numeração divergiu no meio do épico, e esta tabela é a que vale.** A versão anterior
> reservava a **Fase 3** para "upload de logo" e chamava a marca por organização de Fase 2 —
> enquanto os commits, o plano de execução e as seções deste arquivo já usavam outra contagem
> (Fase 2 = a tela `/admin/marca`, Fase 3 = marca por organização). Duas numerações para o mesmo
> trabalho é como uma sessão conserta a fase errada. **O upload de logo saiu do épico** e virou
> dívida declarada (D3 abaixo): o logo continua vindo do `.env`, e nenhuma tela o edita.

| # | Fase | Estado |
|---|---|---|
| **0** | **Encoding do `.env` — bloqueador medido** | ✅ `c3764437` |
| **1** | Derivação de cor (rampa + contraste) e a cor da instalação chegando à tela | ✅ 1a `e318d1a7` · 1b `c4395adf` + `f619f23d` · 1c (tabela `platform_branding` + resolvedor) `0872214d` |
| **2** | Tela `/admin/marca` — ver, mudar, e ver o estado quando a cor não pinta | ✅ `50c20179` |
| **3** | Marca **por organização** (nome + cor), com tela própria e CSS escopado | ✅ `0513755c` · `032ba43a` · `a8ec1d99` · `55b6f6ea` · `6b33a258` |
| **4** | As saídas **sem DOM** — e-mail, remetente, PDF de LGPD, autenticador, suporte | ✅ `a6acb9f1` |
| **5** | Favicon em runtime, barra do navegador, e-mails de acesso do Supabase | ✅ `71616d78` + `741c4ec8` |
| **6** | Documentação, mapa vivo, jornada, checklist e os números velhos de CI | ✅ *(esta sessão)* |

**Fora do épico, que ele expôs e outra frente resolveu:** dar `image:` ao worker (a atualização
não alcançava o runtime do agente). Registrado em `docs/runbooks/remediar-worker-congelado.md`.

---

## O que já foi MEDIDO (não presumido)

Cada linha aqui foi verificada lendo o arquivo. Onde diz *(workflow)*, o número veio
de um agente que rodou o cálculo — e está marcado de propósito.

### A premissa do pedido estava parcialmente errada

- **`lib/branding.ts` já existe** — nome + logo por `.env`, lidos em runtime.
  Deliberadamente **não** `NEXT_PUBLIC_*`: a imagem Docker é pré-buildada e a marca
  do revendedor nunca apareceria. **8 call sites; 6 rodam sem organização resolvida.**
- **`docs/white-label.md` já promete isso em público**, em 3 idiomas, e lista os
  buracos exatos: *cores/fontes/tema não configuráveis*, *marca por instalação e não
  por organização*, *textos e e-mails seguem o padrão do produto*.
- **`docs/design-system/screen-flow/03-screen-inventory.md:149`** já inventariou a
  rota `/app/settings/tenant/branding` com `<BrandingForm>`, prioridade P2.
- **`app/design/lib/tokens.ts`** tem 5 paletas completas (sage/clay/mist/plum/olive),
  accent de 11 stops, neutros light e dark **desenhados separadamente**.

### Defeitos pré-existentes encontrados no caminho

| Defeito | Evidência | Fase que conserta |
|---|---|---|
| **Gate de marca verde enquanto a marca vaza** — `/G&M CRM/` case-**sensitive** | `tests/unit/branding.test.ts:90`; passam `support@gabarronmathias.com.br` (`app/account-suspended/page.tsx:17`), `suporte@gabarronmathias.com.br` (`app/app/settings/billing/page.tsx:26`), `gm-crm-recovery-codes.txt` (`components/auth/RecoveryCodesPanel.tsx:34`) | 1 |
| **Colisão de cor Δ=0,0° no tema escuro** — `--color-success` é a mesma string de `--color-accent-400` | `app/globals.css:167` e `:193`, ambos `#82a077` | 1 |
| **Corrida no `settings` jsonb** — SELECT→spread→UPDATE sem `.select()`; `visibility_mode` mora no mesmo jsonb | `app/actions/settings/updateTenant.ts:56-83` | 3 |
| **`[data-theme="light"]` não existe** — `:root` casa só `<html>`, então tema claro não é escopável em subárvore | `grep -c 'data-theme="light"' app/globals.css` = 0 | 1 |

### Topologia real do público-alvo

- **Supabase é cloud**, provisionado pela Management API (`hostgator-setup-kit/supabase-provision.sh`).
  Storage não consome disco da VPS, mas consome **cota do plano do cliente**,
  competindo com `whatsapp-media`. Plano grátis: 2 projetos por usuário.
- **O scheduler da VPS já roda 16 crons** (`docker-compose.prod.yml:145-172`) — o
  anti-morte por cron **existe** para o público principal. A Vercel é o caso degradado.
- Serviços do compose: `app`, `worker`, `waha`, `redis`, `srh`, `scheduler`, `caddy`.
  **Dois processos Node** (app + worker), não N lambdas — isso muda a escolha de cache.
- A única policy de escrita em `organizations` é `orgs_write_platform_admin`
  (`supabase/baseline.sql:3415`, `FOR ALL`). Pelo client de sessão o UPDATE de um
  admin de tenant casa **0 linhas e o PostgREST devolve sucesso**. O molde correto
  (admin client + gate de papel + filtro explícito) está em `updateTenant.ts:31-50`.

---

---

## Fase 0 — o bloqueador, medido por mim

### O defeito

`hostgator-setup-kit/install.sh:436` grava o `.env` com aspas simples e escape `'\''`.
Para `APP_NAME = Sant'Ana Odontologia` isso produz `APP_NAME='Sant'\''Ana Odontologia'`,
e o **Docker Compose recusa ler o arquivo inteiro**:

```
failed to read .env: line 1: unexpected character "\" in variable name "\''Ana Odontologia'"
docker compose config -> rc=1    ps -> rc=1    pull -> rc=1
```

**Controle positivo:** o mesmo arquivo, uma variável mudada (sem apóstrofo) → rc=0.
**Controles negativos:** cifrão e cerquilha passam (rc=0) — o defeito é específico do apóstrofo.

Onde morde: `APP_NAME` é a **última** pergunta da entrevista (`install.sh:996`), sem
validador; o `.env` é escrito em `:1303`; o baseline é aplicado e o dono é criado por
caminhos que **não usam compose** (passam) — e só então `dc pull`/`dc up -d` (`:1473`)
morrem. O comprador fica com Supabase provisionado, schema aplicado, admin criado, e um
erro sobre "variable name" que não aponta para nada que ele digitou. Como `dc()` não passa
`--env-file`, **todo** comando do kit passa a falhar: `healthcheck.sh`, `update.sh`,
`backup.sh`, e o agente de 5 em 5 minutos.

"Sant'Ana", "D'Ávila", "Espaço D'Or" são nomes de empresa brasileiros comuns. E vale para
`OWNER_PASSWORD` com apóstrofo.

### Por que nenhum gate pegava

O round-trip do `.env` em `test-validators.sh:303-325` exercita **só** o `load_env` do
bash, e o fixture não tem apóstrofo interno. Nenhum teste do kit roda `docker compose`
contra um `.env` gerado. Ponto cego em dois eixos ao mesmo tempo: o **consumidor** não
coberto e o **caractere** não coberto.

### São TRÊS consumidores, não dois

1. `load_env` (`_common.sh:252-276`) — parsing manual com `printf -v`, **não** `source`.
2. `docker compose` via `env_file: .env` (`docker-compose.prod.yml:34,71`).
3. `source .env && curl …` — receita real em `hostgator-setup-kit/README.md:143`.

### A solução, escolhida por medição

18 combinações (6 valores × 3 consumidores):

| encoding + leitor | `load_env` | `source` | contêiner |
|---|---|---|---|
| atual (aspas simples + `'\''`) | 6/6 | 6/6 | **4/6** |
| aspas duplas + `load_env` atual | **3/6** | 6/6 | 6/6 |
| **aspas duplas + `load_env` com patch** | **6/6** | **6/6** | **6/6** |

`envq` passa a usar aspas duplas escapando `` \ " $ ` ``, e o `load_env` desfaz esse
escape. O ramo de aspas simples **fica** — clone que atualiza não reescreve o `.env`.

> ⚠️ **Nota sobre o meu instrumento:** o contador automático de falhas do meu script
> media só o contêiner (incrementava dentro de `$( )`, que é subshell). As linhas
> individuais são a verdade; a tabela acima veio delas, não do contador.

---

## Achados fora do escopo, que o épico expôs

| Achado | Evidência | O que muda |
|---|---|---|
| **O worker não tem `image:`, só `build:`** — único dos 7 serviços | `docker compose -f docker-compose.prod.yml config` resolvido pelo próprio Docker | `install.sh` roda `dc up -d` sem escopo → **a VPS compila**, contra o que `hostgator-setup-kit/README.md:91` promete. E `update.sh` (`dc pull` + `up -d` sem `--build`) → **o worker segue com código velho**. Consequência é inferência da semântica do Compose; falta observar numa VPS |
| **Regra para o épico** | — | Trabalho agendado da marca vai em `app/api/v1/cron/*` batido pelo `scheduler`, **nunca** no worker — é o único componente que não recebe código novo |
| **Apêndice do baseline: bucket chega, mudança de policy some** | Reprodução em Postgres descartável: `ERROR: policy already exists` e o statement seguinte entra | Todo bloco de policy do apêndice nasce com `drop policy if exists`. Todo bucket com `on conflict (id) do …` |
| **Cota do Supabase é do cliente e ninguém a mede** | `docs/SETUP.md:76` (1 GB, e é a única ocorrência no repo — está no guia de **dev**) | O bucket de marca disputa 1 GB com toda a mídia de WhatsApp, que **não tem poda por idade** (`media_retention_days` é campo morto). Teto de upload **512 KB**, não 2 MB, e apagar o objeto anterior na troca |
| **A organização sempre nasce "Minha Empresa"** | `install.sh:1441`, literal — logo depois de o instalador perguntar `APP_NAME` | O `install.sh` não ganha pergunta nova; passa a **usar** o que já tem |
| **Não existe favicon** | `public/` só tem `llms.txt`; nenhum `app/icon.*` | A aba não tem marca nenhuma, nem a nossa |

---

## A doutrina do repo está velha em dois pontos (medido 2026-08-13)

O `CLAUDE.md` é a lei deste repo, e ele mesmo avisa que um destes números "já apodreceu
duas vezes". Apodreceu de novo:

| O `CLAUDE.md` diz | Medido |
|---|---|
| 4 checks obrigatórios na `main`: `verify, build-and-size, invariants, e2e` | **5** — `gh api …/branches/main/protection` devolve `verify, build-and-size, invariants, e2e, imagens-ok` |
| "**37 das 39 specs**" Playwright | **45 specs no disco** (`ls tests/e2e/*.spec.ts \| wc -l`) |

Não corrigi aqui: o `CLAUDE.md` é doutrina compartilhada e mexer nele no meio de um épico
conflita com outras sessões. **Fica como item próprio.** E a régua honesta para "quantas
rodam" não é contar à mão — é o gate `tests/unit/e2e-cobertura-completa.test.ts`, que
está **verde**: toda spec do disco está declarada em alguma das três listas.

> Tentei contar as listas com `sed` e obtive `SPECS_PARTE_1: 45` **e** `FORA_DO_CI: 45` —
> impossível, o delimitador não casou. Não repasso número que não medi.

## Uma armadilha da suíte e2e que vale além deste épico

`scripts/seed-e2e-system-update.ts:52-68` **promove `e2e-admin@gabarronmathias.test` a
`platform_admin`** — insere, e reativa se estiver revogado. **Nenhum seed do repo
revoga**: o único `revoked_at` que existe é em `seed-e2e-agente-mcp.ts`, sobre tokens de
API. Como as duas partes do job `e2e` compartilham o mesmo banco sem reset, **toda a
parte 2 roda com esse admin já promovido**.

Consequência para qualquer spec que queira provar comportamento de **admin de tenant**:
usar o `e2e-admin` mede o produto errado e passa verde. Por isso a Fase 3 cria
`e2e-marca-admin@gabarronmathias.test`, sem linha em `platform_admins`, e a spec **afirma a
precondição** (zero linhas ativas) antes de medir — senão verde é resultado de
instrumento morto.

---

## Bugs achados executando

### 🔴 BUG-01 — o anel de foco perde o contraste no tema escuro com marca escura

**Achado na tela, não em teste.** Dev na 3111, `APP_ACCENT_HEX="#0f172a"` (navy), medido
com `getComputedStyle` em `/login`:

| par | Sage (controle) | navy | piso |
|---|---|---|---|
| claro: `accent-500` × bg | 3,79 | 10,77 | 3,0 ✅ |
| claro: `accent-500` × surface-elevated | 3,60 | 10,22 | 3,0 ✅ |
| **escuro: `accent-400` × bg** | 4,58 | **2,86** | 3,0 ❌ |
| **escuro: `accent-400` × surface-elevated** | — | **2,37** | 3,0 ❌ |

**Causa raiz:** `globals.css:376,381` — o anel de foco usa stops **fixos e diferentes por
tema** (500 no claro, 400 no escuro), e esse stop não passa pela caminhada de contraste
que governa o accent de ação. A rampa é única, então `accent-400` vale o mesmo nos dois
temas e no escuro é comparado contra um fundo quase preto.

**Por que nenhum teste pegou:** os testes exercitam a **função de derivação**, não os
**pares que o produto realmente pinta**. É a diferença entre cobrir caminhos e cobrir o
call site.

**Gravidade:** WCAG 1.4.11 é nível AA, e o indicador de foco é o exemplo canônico da
norma. O produto **cumpria antes do épico** e deixaria de cumprir por causa dele.

**Estado:** conserto em execução, com a guarda que fecha a classe inteira (todos os pares
papel × superfície × 16 sementes) e controle positivo de que a Sage não se move.

### ⚪ BUG-02 — 12 chunks `/_next/static/` dão 403 no browser em dev

Aparece no **controle também**, então não é do épico. `curl` no mesmo chunk devolve
**200**, e `/^\/_next\//` está em `PUBLIC_PATHS` — não é o proxy. Assinatura de Turbopack
gerando chunk sob demanda. **A confirmar no build de produção**, onde os chunks são
estáticos; se sumir lá, é artefato de dev e não vale conserto.

---

## Prova em tela — Fase 1b (dev, porta 3111)

| o que | controle (sem var) | navy `#0f172a` |
|---|---|---|
| `/login` | HTTP 200 | HTTP 200 |
| bloco de marca no `<head>` | — | **1 bloco com `--color-accent`** |
| `--color-accent` claro | `#506d48` | **`#0f172a`** ← a semente sobrevive intacta |
| `--color-accent` escuro | `#82a077` | `#828a9d` |
| alternância de tema sobrevive | sim | **sim** |
| alternância é reversível | sim | **sim** |
| `[data-theme="light"]` escopa em subárvore | **sim** (`#faf9f6` sob root escuro) | sim |
| colisão accent × success (escuro) | **COLIDE** | **ok** ← a reconciliação funciona |
| accent × surface (claro) | 5,80 | 17,85 |

**Os dois resultados que mais importam:** a navy **permanece `#0f172a`** — é a ancoragem
por papel funcionando na tela, não no papel — e a colisão accent/success do tema escuro,
que o produto tem hoje, **passa a `ok`** quando a reconciliação roda.

### Instrumento meu que falhou três vezes nesta rodada (e o que aprendi)

1. `import { chromium } from "playwright"` — o repo tem `@playwright/test`, não `playwright`.
   ESM resolve a partir do diretório **do arquivo**, não do cwd.
2. Parser de hex assumindo 6 dígitos — `--color-surface` no claro é `#fff` e
   `--color-accent-soft` no escuro é `#82a07729`. Devolvia `None` em silêncio.
3. **O mais grave:** medi o anel de foco com `accent-500` **nos dois temas**, quando o
   produto usa 400 no escuro. O número que reportei primeiro (1,61) era de um token que o
   produto não pinta. O defeito é real, mas o valor certo é **2,86**.

Todo número da tabela acima é de run posterior a essas correções.

---

## Fase 0 — ENTREGUE (`c3764437`)

**O conserto.** `envq` passa a aspas duplas escapando `` \ " $ ` ``; o ramo de aspas
duplas do `load_env` desfaz esse escape (sentinela `\001` para não reprocessar `\\`).
O ramo de aspas simples **fica** — clone que atualiza não reescreve o `.env`.

**Prova que eu mesmo rodei**, com o `envq` real do disco (não uma cópia):

| valor | linha gravada | `load_env` | `source` | contêiner |
|---|---|---|---|---|
| `Sant'Ana Odontologia` | `APP_NAME="Sant'Ana Odontologia"` | ok | ok | ok (rc=0) |
| `Casa "Bela" #1` | `APP_NAME="Casa \"Bela\" #1"` | ok | ok | ok (rc=0) |
| `se$nha P$ss` | `APP_NAME="se\$nha P\$ss"` | ok | ok | ok (rc=0) |

`pnpm test:shell` medido por mim: **EXIT=0 · 232 ✓ · 0 ✗** (era 201). Os casos novos
cobrem os três consumidores contra uma lista única de 8 valores, mais **controle
positivo** (o formato antigo é recusado pelo Compose — é isso que prova que o teste
vigia) e retrocompatibilidade com `.env` no formato velho.

Sabotagem, previsto vs medido: **9/9, 9/9, 1/1, 24/24** (a última é guarda de vacuidade).

**Residual conhecido e documentado:** o parser do Compose não desfaz `` \` `` dentro de
aspas duplas, então valor com crase chega feio ao contêiner. Mantido de propósito — a
alternativa é o `source .env` do README **executar** o que está entre crases.

**Revisão que fiz do trabalho do subagente:** ele alterou 7 asserções pré-existentes.
Conferi uma a uma — são todas troca de aspas na asserção (`grep -qx "X='v'"` →
`grep -qx 'X="v"'`), acompanhando o formato novo, ainda ancoradas com `-qx`/`^`.
Nenhuma afrouxada.

> ⚠️ **Ainda não provado:** instalação real numa VPS. Isto cobre o encoding e seus três
> leitores, não a jornada do comprador ponta a ponta.

---

---

## Decisões das 6 lentes novas (43 achados brutos → 6 aprovados)

### PACKAGING: **NÃO.** Não vira monorepo, não vira pacote npm.

Regra de extração é ≥2 consumidores independentes; medido **1** — os 8 importadores de
`lib/branding` estão todos em `app/` e `components/`, e o worker não renderiza marca
nenhuma. Custo do contrário: 2 Dockerfiles (`--frozen-lockfile` quebra em workspace),
`output: "standalone"` (o artefato vira `.next/standalone/apps/web/server.js` e quebra o
`COPY`/`CMD`), 2 tsconfig, 2 aliases de vitest, e **53 testes de arquitetura ancorados em
caminho top-level cujo helper devolve `[]` em diretório inexistente** — ou seja, trocar
risco de gate vacuamente verde por zero ganho.

**O packaging que de fato falta é outro: um emissor de build-time multi-formato.** A marca
atravessa 4 fronteiras de processo e **3 não consomem TypeScript**: o `StyleSheet` do
`@react-pdf` (não lê CSS var), o HTML inline dos e-mails, e os templates Go do Supabase
Auth. ~80 linhas + um teste que reprova quando o gerado diverge do commitado. Fase 4.

**Imagem Docker por marca fica proibida — agora com prova:** `update.sh:158-159` grava
`APP_IMAGE` no `.env` **incondicionalmente**, e `set_env_var` faz `grep -v` + append sem
merge. A imagem do revendedor seria substituída pela upstream num update de rotina, em
silêncio. O desenho atual (imagem genérica + marca em runtime) está certo — o trabalho é
**protegê-lo** com um caso em `update-guard.test.sh`.

### Os 6 ângulos aprovados

| # | Ângulo | Fase | Custo |
|---|---|---|---|
| 1 | **Forma do que se grava** — jsonb guarda ENTRADA (`{format, algo, semente_hex}`), nunca saída; schema *loose com catchall* (exceção declarada ao `.strict()` do repo); resolvedor **nunca lança** | 1 | ~3h |
| 2 | **O gate de derivação mede o token errado**, em 3 eixos | 1 | ~1,5d |
| 3 | **A varredura de marca não alcança onde a marca sai** | 4 (parte na 1) | ~7h |
| 4 | **Emissor multi-formato** (o packaging real) | 4 | ~2d |
| 5 | **Diagnóstico emite FORMA, nunca IDENTIDADE** | 1 | ~3h |
| 6 | **Billing entrega o cliente do revendedor para nós** | 0/1 | ~1d |

**Ângulo 1 — por que é irreversível.** Ninguém tinha medido o que o **código velho** faz
com o jsonb do código novo. E o rollback põe código velho sobre schema novo *por
construção*: `update.sh` aplica o baseline antes de puxar a imagem, e `agent.sh` reverte
só `APP_IMAGE`. Com `.strict()`, chave desconhecida **lança** — e como `branding()` é
chamado em `app/layout.tsx`, um throw ali é **500 em todas as telas**. O envelope
`{format, algo}` nasce na Fase 1 mesmo sem tela de import/export: é a única superfície que
atravessa instalações, e retrofit é impossível (sem ele, toda linha existente vira "algo
desconhecido").

**Ângulo 2 — a régua ordena invertido.** Simulação de dicromacia (matrizes Machado 2009)
reproduzida de forma independente:

| par | ΔH | ΔE deuteranopia |
|---|---|---|
| oliva `#7f8c3a` × warning | **44,7°** (passa com folga) | **0,0231** |
| verde-água `#1abc9c` × success | **27,2°** (mal passa) | **0,1264** |

Maior ângulo, pior separação. Troca: **ΔE em OKLab sobre a cor simulada**, piso ≥ 0,05.
Mais duas correções: **(b)** quem se move são as *nossas* semânticas, nunca o accent — a
cor da marca é a única que não nos pertence; **(c)** o piso é por **papel × superfície**,
não pela semente — medido na Sage, `accent-600` vs bg = 5,51 (o que o piso checa) mas o
anel de foco usa `accent-500` e dá **3,79**; com a semente no piso de 3,0, o anel pousa em
~2,07 **com o gate verde**. Por isso os pares saem extraídos do `globals.css`, nunca
listados à mão.

### Os que NÃO valem (isto impede o épico de inchar)

Monorepo · `@deskcomm/tokens` no npm · Turborepo/Nx · style-dictionary · regra eslint de
fronteira · **regressão visual por screenshot em qualquer volume** (não pega nenhum dos
defeitos medidos, e custa 136 MB num repo cuja estratégia é otimizar para fork) · Percy /
Chromatic / Argos (check pago = vermelho permanente em fork) · Storybook (os defeitos são
de container e tema, não de componente) · `prefers-contrast` · domínio por organização ·
DSN de Sentry por org · página de status pública · phone-home · cota de logo ·
"remover o selo é pago" · **seletor de fonte** (Atkinson Hyperlegible foi escolhida pelo
Braille Institute por legibilidade; trocá-la não muda percepção de marca e só piora a
leitura do operador).

### Correção de um erro meu

**Eu afirmei que `app/design` é rota pública sem auth. É falso.** Minha sonda procurou em
`middleware.ts`, que **não existe** — o Next 16 renomeou para `proxy.ts`, que existe e
está na raiz. `/design` não está em `PUBLIC_PATHS` (`lib/auth/public-paths.ts:5-27`), e
`proxy.ts:32` redireciona quem não bate na allowlist. A rota é **autenticada**; o
problema real é vazamento cross-tenant, e o conserto é `notFound()` fora de dev (20 min),
não remover da build. Grep sobre arquivo inexistente devolve vazio, indistinguível de
"não achei" — [[feedback_instrumento_quebrado_devolve_zero]] outra vez.

### A pergunta que ninguém tinha feito: **quantas identidades o produto precisa modelar?**

`lib/lgpd/pdf-renderer.tsx:277` imprime, no documento entregue ao **titular de dados**:

> `G&M CRM · Relatório LGPD Art. 18 II · DPO: contato via canal oficial do controlador`

Dois defeitos. O primeiro é o vazamento de marca (ângulo 3 pega). O segundo ninguém tocou:
**o sistema já sabe o DPO e não o imprime** — `lib/env.ts:134` tem `LGPD_DPO_EMAIL` e
`lib/lgpd/sla-alarm.ts:93` resolve `organizationDpoEmail || env.LGPD_DPO_EMAIL`.

E o buraco que o whitelabel abre: em toda outra superfície, marca = **quem vende**. No
relatório de Art. 18, a identidade correta é o **controlador** — a empresa cujos dados
são. Se a Fase 4 tratar esse rodapé como "mais uma saída sem DOM" e trocar o nome pela
marca do revendedor, ela **piora** o defeito: nomeia o revendedor como controlador num
documento que responde a um direito legal, quando o controlador é o cliente dele.

**DECIDIDO (2026-08-13): quatro papéis, três identidades de marca, zero campos novos.**

`organizations` **já** separa `legal_name` (NOT NULL) de `display_name` — medido no
`baseline.sql`. A identidade jurídica já está modelada; ninguém a estava usando.

| Papel | Onde vive | O que carrega |
|---|---|---|
| Nós (o produto) | selo removível | só isso |
| **Instalação** | `platform_branding` | marca visual pré-login |
| **Organização — marca** | `display_name` + `settings.branding` | o que aparece na tela pós-login |
| **Organização — controlador** | `legal_name` *(já existe)* | identidade jurídica no PDF de LGPD |

**Por que `controlador` não é campo novo:** DIRC responde **I — Integrar**. O controlador
de dados é a organização, e a organização já declara sua razão social. Criar
`controlador_nome` seria duplicação sem source of truth (anti-pattern nº 2 do CLAUDE.md).

**Consequência para a Fase 4:** o rodapé do PDF de LGPD passa a imprimir `legal_name` +
DPO resolvido (`organizationDpoEmail || env.LGPD_DPO_EMAIL`), **não** a marca. Trocar o
nome pela marca do revendedor ali pioraria o defeito — nomearia o revendedor como
controlador num documento que responde a um direito legal.

**O caso previsto:** revendedor hospeda para um cliente que atende sob outra razão social.
Resolve-se com **uma organização por razão social**, que é o que a tenancy já modela — não
com um campo a mais. Se algum dia uma organização precisar declarar controlador diferente
da própria razão social, aí sim é campo novo, e a razão estará escrita aqui.

---

## Achados novos confirmados por mim

| Achado | Evidência |
|---|---|
| **Todo projeto Supabase do revendedor nasce chamado "G&M CRM"** | `install.sh:918` usa `${APP_NAME:-G&M CRM}`; `APP_NAME` só é coletado em `:1024` — **106 linhas depois** |
| **O primeiro e-mail que o cliente do revendedor recebe diz o nome do nosso produto** | `supabase/templates/confirmation.html:4` e `recovery.html:4`; e **nenhum script sobe esses templates** — só `config.toml` (Supabase local) e um teste |
| **A tela de dinheiro entrega nosso contato ao cliente do revendedor** | `lib/navigation/registry.ts:453` (porta de 1ª classe, "Billing") → `app/app/settings/billing/page.tsx:26` mostra `suporte@gabarronmathias.com.br` |

---

---

## Fase 1a — ENTREGUE (`e318d1a7`): derivação de cor

`lib/branding/rampa.ts` + `contraste.ts`, funções puras, zero dependência nova.
37 testes. **Números que eu reproduzi de forma independente**, não repassei:

| medição | subagente | eu |
|---|---|---|
| `#0f172a` croma | 0,039824 | **0,039824** |
| `#1a1f36` croma | 0,044430 | **0,044430** |
| cinzas (`#808080`, `#000000`) | ~0 | **0,000000 exato** |
| calibração Sage, Δ por canal | ≤ 2/255 | **Δmax=2**; stops 500/600/700/900/950 exatos |

Gates medidos por mim: `typecheck` 0 · `lint` 0 · `test:unit` **4182 passed (+37)**.
As 5 falhas visíveis são de `lib/ai/dispatcher/rate-limit.test.ts` e são
**pré-existentes** — provado removendo os arquivos novos do disco e rodando com a árvore
limpa no HEAD: falha 5/5 igual.

### Dois números de croma, não um — e a diferença decide o épico

`#0f172a` mede **0,039824** e `#1a1f36` mede **0,044430**: as duas navies caem em lados
opostos de 0,04 por **0,0046**. Com um gatilho único em 0,04, a navy que motiva o épico
inteiro perderia a marca e receberia Sage. Então `LIMIAR_ACROMATICO = 0,01` (cinza mede
0,000000 exato — 40× de margem) é o **gatilho**; `PISO_DE_CROMA = 0,04` continua como
**asserção** sobre o accent que resta.

### A sabotagem que reprovou menos rendeu mais que o teste

Previsto 4, medido 2 na sabotagem de `CURVA_C`. Investigado: o modelo mental era do
autor, não do teste — a caminhada de contraste e a reconciliação são governadas por
**lightness**, e `CURVA_C` só mexe em **croma**.

E o achado maior: **a sabotagem da ancoragem NÃO é pega pela calibração Sage**, porque a
semente Sage tem L exatamente igual a `ESCADA_L[6]` — ancorar por lightness dá o mesmo
resultado ali. Por isso os testes de ancoragem existem separados; sem eles, a catraca
principal daria falso verde justamente na regra mais importante.

### Meu instrumento me traiu (de novo)

Escrevi um teste de verificação chutando o formato de retorno (`.stops`, `.croma`),
recebi `NaN`/`undefined`, e teria concluído que o código estava errado. `Rampa` é uma
**tupla de 11 strings**. Li a assinatura, refiz com controle negativo, e os números da
tabela acima são do run correto.

### Dívida declarada

Nada consome esses módulos. **O invariante 1 (nada é ilha) NÃO está satisfeito** — está
escrito no commit. A Fase 1b fecha isso.

---

## Defeitos pré-existentes anotados no caminho (fora do escopo, não esquecidos)

| Defeito | Evidência |
|---|---|
| `lib/ai/dispatcher/rate-limit.test.ts` falha 5/5 por timeout de 15s | Reproduzido com árvore limpa no HEAD |
| `--color-accent` usado como **texto** fora do CSS mede **4,02** no tema escuro (< 4,5 de WCAG 1.4.3) | `app/app/ai/followups/[id]/_components/nodes/nodeVisuals.ts:32` (`bg-accent-soft text-accent`) e `.ds-badge--accent`. Consertar move o accent escuro do produto de 400 para 300 — **decisão de design system, não deste épico** |

---

## Fase 1c — ENTREGUE (working tree, NÃO commitada): a marca sai do `.env` e vai para o banco

**Trio de migration completo** (a doutrina exige os três juntos):

| Artefato | Arquivo |
|---|---|
| migration | `supabase/migrations/20260813090000_0155_marca_da_instalacao_no_banco.sql` |
| apêndice idempotente | `supabase/baseline.sql` (+95 linhas, **0 remoções**, antes do `notify pgrst` final) |
| MANIFEST | `supabase/migrations/MANIFEST.md` (linha nova) |

**Numeração, com a medição que a justifica** (as duas réguas são independentes):

- `NNNN = 0155` — maior existente **em TODAS as branches locais** é `0154`. Medido com o
  mesmo laço do `loop/hooks/check-migration-triple.sh` (`git branch` × `git ls-tree`), não
  só neste checkout: `0155` não aparece em branch nenhuma.
- `timestamp = 20260813090000` — maior existente é `20260811210000`. A ordem de aplicação é
  por timestamp, e ele **não** é monotônico com o `NNNN` neste repo (a `0119` tem timestamp
  maior que a `0142`), então os dois se medem separado.

### Código

| Arquivo | O quê |
|---|---|
| `lib/branding/instalacao.ts` | **novo** — leitura, semeadura, memo com TTL, estado do fallback |
| `lib/branding/resolve.ts` | `camadaDaInstalacao()` ao lado de `camadaDoAmbiente()` — o resolvedor foi **estendido**, não reescrito |
| `app/layout.tsx` | pilha `[banco, env]`; `generateMetadata` virou `async` e lê a marca resolvida |
| `app/actions/settings/updateBranding.ts` | **nova** server action (gate `is_platform_admin`) |
| `lib/schemas/settings.ts` | `platformBrandingSchema` |
| `lib/audit/actions.ts` + `components/admin/audit/action-codes.ts` | `platform_branding.updated` nas **duas** listas |
| `tests/unit/branding-instalacao.test.ts` | **novo** — 26 casos (decisões, sem I/O) |
| `tests/invariants/marca-da-instalacao.test.ts` | **novo** — 14 casos (privilégio, comportamento, CHECK, trigger) |

### Prova em Postgres descartável (`pgvector/pgvector:pg17`, o harness do repo)

```
==> modo INSTALL: aplicando baseline.sql com ON_ERROR_STOP=1
psql:<stdin>:4084: WARNING:  "wal_level" is insufficient to publish logical changes
    ✓ install ok
==> modo UPDATE: re-aplicando baseline.sql sem ON_ERROR_STOP (idempotência)
    ✓ update ok (re-apply terminou; erros tolerados por contrato)
```

O `update` emite **301** erros — todos do corpo do `pg_dump` (PK, índice, FK e policy
"already exists"), que o harness tolera por contrato. Linhas do `update` citando
`platform_branding`: **zero**, medido com
`awk '/^==> modo UPDATE/,/update ok/' | grep -ci platform_branding`, não a olho.

**Como sei que o delta do meu bloco é 0 sem ter medido o HEAD:** a sabotagem 2 move a
contagem de **301 → 302**, e a linha a mais é exatamente a que nomeia a tabela. O par
"zero menções + a sabotagem produz uma" prende o número dos dois lados; a contagem no
HEAD eu **não** rodei, e não a afirmo.

### Gates (medidos por mim, com o `.env.local` fora do disco)

| Gate | Base | Depois |
|---|---|---|
| `pnpm typecheck` | 0 | **0** |
| `pnpm lint` | *(não medi no HEAD)* | **0 erros / 241 warnings** no repo. A medição que vale é direta: `npx eslint` nos **13 arquivos criados/alterados** devolve **saída vazia** — 0 erro e 0 warning meus. Os 241 são dívida de estilo pré-existente; não afirmo que eram 241 antes porque não rodei no HEAD |
| `pnpm test:unit` | 378 files / 4284 tests | **379 / 4310, EXIT=0** (+1 arquivo, +26 casos — bate exato) |
| `pnpm test:db` | — | **101 files / 732 passed · 1 expected fail · 1 skipped, EXIT=0** |

### Sabotagem — previsto vs medido

| # | O que sabotei | Previsto | Medido |
|---|---|---|---|
| 1 | `revoke all … from anon, authenticated` fora do baseline | 5 | **5** |
| 2 | `create table if not exists` → `create table` (idempotência) | 1 erro no `update`, **0** reprovações | **1 erro, 0 reprovações** (301 → 302) |
| 3a | `precisaSemear` sempre `"nao"` | 2 | **2** |
| 3b | guarda `if (!linha.seeded_from_env) return "nao"` removida | 1 | **1** |
| 4 | filtro `CODIGOS_DE_RECUSA` do fallback removido | 5 | **5** |

**O que a sabotagem 1 mediu, e é o achado que justifica o bloco de comentário:** sem o
`revoke`, `anon` fica com `DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE` na
tabela — o `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon` do próprio baseline
alcança toda tabela criada depois dele. E o caso **comportamental** reprovou com
`erroSob` devolvendo `null`: `anon` LEU sem erro (a RLS devolve zero linha calada). É
por isso que catálogo e comportamento são dois casos e não um — e a mensagem de falha
foi melhorada (`esperaBarrado`) para dizer "a tabela está exposta" em vez de reclamar de
`toContain` sobre `null`.

### Um defeito MEU, pego por um gate que já existia

`pnpm test:unit` reprovou `tests/unit/audit-resource-id-e-uuid.test.ts`: eu tinha escrito
`resourceId: "1"` (a chave do singleton) e `api_audit_log.resource_id` é `uuid`. O INSERT
do audit estouraria com 22P02 e — como audit é fire-and-forget por doutrina — a marca
seria gravada, a tela diria "salvo" e a trilha ficaria **sem a linha, sem sintoma**.
Corrigido para `resourceId: null` (a tabela tem uma linha; `resourceType` já a identifica).

### Achados que NÃO consertei (dívida alheia, registrada em vez de misturada)

1. **As duas listas de ação de auditoria já divergem em 120 códigos.** Medido em
   2026-08-13, com a minha entrada já nas duas: **208** no union de `lib/audit/actions.ts`
   contra **88** em `components/admin/audit/action-codes.ts`; o inverso é **0**. O
   comentário do topo diz *"keep in sync manually"* e **não há gate nenhum**. O conserto
   certo é derivar a lista do union, não copiá-la melhor — item próprio.
2. **Apêndice não-idempotente não é pego por gate nenhum.** A sabotagem 2 provou:
   `test:db` sai **0** e a suíte fica **14/14 verde** com o `create table` duplicando erro
   no `update.sh` de todo clone, porque o modo update tolera erro **por contrato**. Quem
   detecta é o diff de stderr, que hoje ninguém roda. Um gate barato seria comparar o
   conjunto de erros do `update` contra uma lista congelada.

### O que ficou SEM cobertura (declarado, não escondido)

- **Nada foi provado pela tela.** Esta fase não tem UI (a tela de marca é a Fase 2), e o
  DoD 12 só morde quando há UI/fluxo. O que a tela mostraria — `<style id="marca-instalacao">`
  — já foi provado na Fase 1b; o que mudou aqui é **de onde vem** o valor.
- **A server action não tem chamador.** É a Entrada declarada da fase; a tela que a
  aciona é a Fase 2. Enquanto isso, o único caminho para a tabela é a semeadura.
- **`logo_url` e os 8 arquivos que ainda importam `branding()` continuam lendo o `.env`.**
  Medido depois da mudança: `app/layout.tsx` saiu da lista (era 9, é 8) e `generateMetadata`
  (título da aba, herdado por toda página via `template`) é o único consumidor do banco. Medido o motivo:
  `tests/unit/branding.test.ts:71-72` fixa `APP_NAME:\s*env\.APP_NAME` dentro de
  `app/public-env-script.tsx` — e converter o seam do cliente em massa deixaria uma linha
  velha do banco atropelar o `.env` em TODO o produto antes de existir tela para
  corrigir. Fase 2 fecha isso junto com a camada da organização, que precisa do mesmo seam.
- **`lib/database.types.ts` não foi regenerado, e não precisou:** `createAdminClient()`
  devolve `SupabaseClient` **sem** o genérico `Database` (`lib/supabase/admin.ts:24`),
  então `.from("platform_branding")` não passa pelos tipos gerados. Precedente medido: a
  tabela `org_guardrail_layers` (migration 0142) também **não** está lá — `grep -c` = 0.
- **`fallback_at` não tem tela ainda.** É gravado e limpo pelo `app/layout.tsx`; quem lê
  hoje é quem abre o banco. A tela da Fase 2 é a consumidora natural.

---

## Fase 2 — ENTREGUE e PROVADA NA TELA (`0872214d` + `50c20179`)

`public.platform_branding` + tela `/admin/marca`. Ciclo completo medido no browser,
com login MFA real, em build de produção:

| estado | swatches | `--color-accent` |
|---|---|---|
| inicial | 1 | `#506d48` (Sage) |
| digitando `#7a5cd6` | 15 | `#506d48` |
| hex inválido | — | **Salvar desabilitado** |
| salvo | 15 | **`#604aa6`** |
| recarregado | 15 | **`#604aa6`** — persistiu |

`#604aa6` é exatamente o tom que a tela anunciou como "Botões no modo claro".
**A tela não mentiu.** Banco após salvar: `accent_hex=#7a5cd6`, `seeded_from_env=f`.
Zero jargão técnico, zero rolagem lateral.

Cada imagem abaixo é lastro de uma afirmação desta seção:

| evidência | o que ela prova |
|---|---|
| `evidence/marca-1-inicial.png` | estado inicial: sem cor definida, a tira **não** aparece e "De onde vem cada coisa" diz "padrão do sistema" nas três linhas |
| `evidence/marca-2-digitado.png` | ao digitar `#7a5cd6` a tira acende com as três marcações e os contrastes 6,9:1 / 7,8:1 |
| `evidence/marca-3-invalido.png` | hex inválido: borda de erro e **Salvar desabilitado** |
| `evidence/marca-4-salvo.png` | o run que **reprovou**: `Could not find the table 'public.platform_branding' in the schema cache` — o banco local não tinha a migration |
| `evidence/marca-5-recarregado.png` | depois de aplicar a 0155: sidebar e botão roxos, "Cor → definido nesta tela", cor persistida no reload |

### O primeiro run REPROVOU, e o erro apareceu na tela

`Could not find the table 'public.platform_branding' in the schema cache`. Não era bug
do código: o baseline fora provado num Postgres descartável, mas **o Supabase local
nunca recebera a migration**. Aplicada a 0155 no banco local, o ciclo fechou. Sem
dirigir o browser, isto teria virado "está pronto" com a feature morta.

### Dois defeitos de PROSA — nenhum gate pega texto errado

1. A frase do ajuste citava o degrau errado: com `#f5c518` o modo escuro anda +2 e a
   tela dizia *"um tom mais escuro da sua cor"* quando o botão pousa **exatamente na
   cor da pessoa**.
2. Com marca neutra (`#808080`) a tela dizia *"sua cor ficou parecida com sucesso"* —
   sobre uma cor que não pinta nada. A colisão era entre o verde **do produto** e o
   verde de sucesso **do produto**.

### A regra que virou doutrina

`baseline.sql` tem `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon`, e ele vale
para **toda tabela criada depois dele** — todo apêndice novo. Sem `revoke`, `anon` fica
com 7 privilégios. É o análogo, **para tabela**, da regra de `security definer` do item 9
do CLAUDE.md. Medido na sabotagem: sem o revoke o **SELECT passa sem erro**, porque a RLS
devolve zero linha calada — por isso o teste tem dois casos, catálogo e comportamento.

### Higiene do ambiente compartilhado

Durante a prova deixei `accent_hex=#7a5cd6` no Supabase local, que mudaria a cor do app
para **qualquer outra sessão** no mesmo banco. Limpo (`null`/`null`). Spec temporária e
`.env.e2e` removidos.

### Dívida declarada

- **Só o título da aba lê o banco.** Os 8 call sites de `branding()` continuam no `.env`
  — a tela **diz isso** embaixo do campo, em vez de deixar o operador achar que quebrou.
- Logo e `show_powered_by` não têm controle: `Sidebar.tsx:46` lê o logo do `.env`, e
  `show_powered_by` tem **zero** consumidores. Campo que salva valor que ninguém mostra
  seria controle decorativo.
- `fallback_at` é hoje inalcançável pela UI (o CHECK do banco barra hex corrompido).
- **Spec e2e da marca é dívida:** a prova foi por spec temporária, removida porque suja
  o banco compartilhado. Uma spec de verdade precisa de `afterAll` restaurando, e de ser
  declarada em `.github/workflows/e2e.yml` (senão reprova o job **`verify`**, não o `e2e`).

### Defeitos pré-existentes anotados (fora do escopo)

| Defeito | Evidência |
|---|---|
| `border-error-fg/30` **não gera CSS nenhum** no Tailwind 3.4 (opacidade sobre cor em `var()`) — 2 telas do repo estão sem borda | `app/app/contacts/[id]/_client.tsx:64`, `components/contacts/AnonymizeDialog.tsx:102` |
| As duas listas de audit divergem em **120 códigos** (208 no union × 88 no painel) | `lib/audit/actions.ts` × `components/admin/audit/action-codes.ts`, que diz "keep in sync manually" e não tem gate |
| Apêndice não-idempotente **não é pego por gate nenhum** — `test:db` fica verde | o modo update tolera erro por contrato; quem detectaria é um diff de stderr que nenhum job roda |
| **E-mail pessoal do dono no User-Agent** de toda instalação self-host | `lib/nuvemshop/config.ts:13` → sai em `api-client.ts:68`. **Decisão do Rafael**: qual endereço de projeto usar |

---

## Fase 3 — ENTREGUE e PROVADA NA TELA

Commits: `0513755c` (RPC atômica + invariante) · `032ba43a` (camada na pilha) ·
`a8ec1d99` (CSS escopado + layout) · `55b6f6ea` (a tela).

### O que a tela mediu, com admin de tenant PURO

**A precondição falhou primeiro, e era a armadilha prevista:** `e2e-admin@gabarronmathias.test`
**era** `platform_admin` (`seed-e2e-system-update.ts:52-68` promove e nada revoga). Medi
`count = 1`, revoguei, reafirmei `count = 0`, e só então testei. Sem isso o teste teria
passado verde medindo o produto errado.

| | `--color-accent` | `[data-marca-org]` | `#marca-organizacao` |
|---|---|---|---|
| `/app`, org sem marca | `#506d48` Sage | presente | **ausente** |
| `/app`, depois de salvar `#b3261e` | **`#b3261e`** | presente | **presente** |
| `/app`, tema escuro | **`#f16051`** | presente | presente |
| `/login`, sem sessão | `#506d48` | **ausente** | **ausente** |

`persistido = #b3261e` depois do reload — **a issue #144 não se repetiu**: o RPC gravou
de verdade sob um admin que não é platform admin. O bloco de estilo **só existe quando a
org tem marca própria**, e no escuro o valor é outro (o claro não sobrevive por herança).

Evidência: `evidence/org-1-tela.png` (a tela), `evidence/org-2-digitado.png` (a tira
reagindo), `evidence/org-3-salvo.png` (o salvamento), `evidence/org-4-recarregado.png`
(a persistência), `evidence/org-5-login.png` (o caso de volta, sem sessão).

### O ambiente compartilhado saturou no meio, e isso é registro honesto

Depois das primeiras medições o login parou de completar. **Não era o produto:**
`auth.audit_log_entries` acusou **93 tentativas em 10 minutos** (teto: 60/IP/300s) e o
**fator TOTP mudou de ID** — outra sessão re-semeou e invalidou o `.e2e-creds.json`.

Por isso o caso de volta foi medido **sem sessão**: `/login` é rota pública, e a
comparação usa o `#b3261e` já medido em `/app`. Mesma propriedade, mesmo rigor, sem
depender de um login que o ambiente não estava entregando.

### Descoberta lateral

**Revogar o `platform_admin` removeu a exigência de MFA** do usuário — o `mfa_required`
vinha de lá. O helper de login do repo trava esperando a tela de TOTP que deixa de
aparecer, e o sintoma lê como "MFA quebrou". Fica registrado para a próxima sessão.

### Estado deixado no banco local (compartilhado)

- `e2e-admin@gabarronmathias.test` segue **revogado** de `platform_admins`. É o estado correto do
  seed base; quem precisa dele promovido é `seed-e2e-system-update.ts`, que repromove ao
  rodar. Restaurar seria propagar o defeito.
- A marca da org de teste (`E2E Test Org`) ficou gravada com `#b3261e`.

### Sem cobertura, declarado

- **A spec e2e permanente não foi escrita** (commit 6 do plano): a prova foi por spec
  temporária, removida porque suja banco compartilhado. Uma spec de verdade precisa de
  seed próprio (`e2e-marca-admin`, sem `platform_admins`), `afterAll` restaurando, e
  declaração em `.github/workflows/e2e.yml` — senão reprova o job **`verify`**, não o `e2e`.
- **A captura no onboarding** (commit 5) não foi feita.
- O caso do **portal Radix** (menu aberto herdando a cor da org) não foi medido em pixel —
  é afirmação por construção, com o teste de fonte guardando o seletor.

---

## Fase 4 — ENTREGUE (`a6acb9f1`): a marca alcança quem não tem DOM

O seam é `lib/branding/saida.ts`: `marcaDaSaida(orgId | null)` devolve **um hex e uma frente
legível**, tema **claro sempre** (e-mail não tem tema, e `prefers-color-scheme` dentro de
e-mail não é confiável). O piso vem **importado** de `regua-do-produto.ts`, nunca constante
nova — seria a quarta cópia de um hex do produto. Contrato: **nunca lança**, porque quem chama
é o e-mail de LGPD, que responde a direito legal com SLA de D+7.

**O PDF de LGPD não leva marca nenhuma.** Imprime o **controlador** (`legal_name`) e o DPO
resolvido. Nomear ali o revendedor — que é *operador* — inverteria papéis num documento
jurídico. Consequência boa: o `StyleSheet` module-level do `@react-pdf` fica como está, e a
armadilha de ele aceitar `var(--x)`/`oklch()` e descartar a cor **em silêncio** deixa de
existir para nós.

**O remetente é do operador; o nome de exibição é da marca.** `RESEND_FROM_EMAIL` vazio passa a
significar `not_configured`, não o nosso domínio — o fallback antigo fazia *todo* envio falhar
na Resend do revendedor com mensagem opaca. Agora cai no caminho que já existia e já é bom.

8 das 9 dívidas da guarda resolvidas; a 9ª (`ai-budget-alarm`) foi **reclassificada** com
motivo medido, e um caso novo trava o conjunto **pelo nome**, não pelo tamanho.
Sabotagem: **1/1, 3/3, 1/1**. Gates: typecheck 0 · lint 0 · lint:channels 0 · test:unit
386 files / 4399 · test:shell 253 ✓ / 0 ✗ · build 0.

## Fase 5 — ENTREGUE (`71616d78` + `741c4ec8`): a aba, a barra e o primeiro e-mail

**Favicon.** `/favicon.ico` devolvia 404 (19.435 bytes, a `not-found.tsx` inteira) — para nós
e para todo revendedor. `app/icon.tsx` gera em runtime com `next/og`, zero dependência nova,
`force-dynamic` (sem isso o build congela o ícone dentro da imagem, defeito invisível em dev,
em teste e na Vercel, e visível só na VPS). `/^\/icon$/` entrou em `PUBLIC_PATHS`, senão o
ícone respondia **307 para `/login`** — justamente para quem ainda não entrou.

**A barra do navegador não era defeito de whitelabel**, ao contrário do que a medição anterior
dizia: `cssDaMarca` emite só `--color-brand` e a família do accent, **nunca `--color-bg`**. O
defeito real era **duplicação** dos dois hexes em três arquivos. Provado por comportamento:
com `accent_hex='#f2c94c'`, o ícone virou **V sobre `#6e5c28`** (o accent derivado) e o
`theme-color` **não** mudou.

**E-mails de acesso.** `hostgator-setup-kit/marca-emails.sh` sobe assunto e corpo pela
Management API. A medição que destravou a decisão: o `PATCH /config/auth` com
`mailer_templates_*` **é aceito e persiste sem SMTP customizado**. Achado do rig: **projeto
pausado responde 400 "Project is paused."** — modo de falha que um script confiando em 2xx
reportaria como sucesso, e por isso o script **relê** o que gravou.

Sabotagem: **oito, zero divergência**. Gates: typecheck 0 · lint 0 · lint:channels 0 ·
test:unit **389 files / 4426** · test:shell **265 ✓ / 0 ✗** · build 0 com `/icon` dinâmico.

## Fase 6 — ENTREGUE (esta sessão): a documentação para de mentir

- **`docs/white-label.md` reescrito.** As duas frases mais citadas dele eram falsas depois
  deste épico ("cores, fontes e tema não são configuráveis" e "a marca é por instalação, não
  por organização"). Entraram: as duas telas, o banco acima do `.env`, os e-mails (acesso,
  convite, LGPD, suporte), e uma seção própria explicando por que **o PDF de LGPD não leva a
  marca do revendedor**. O que **continua** não sendo configurável agora vem com a razão
  medida: domínio por organização (zero coluna no schema, o desvio por host do `proxy.ts:27` é
  NOOP declarado, e no Edge não há banco), fonte (`next/font` resolve em build e a imagem é
  pré-buildada), tema e logo por organização.
- **Mapa vivo** `docs/architecture/marca-propria.architecture.json` — 37 peças, 54 arestas, 6
  faixas, com o **PDF declarado FORA da marca** e um caso no gate que reprova quem o ligar ao
  resolvedor. Duas linhas entraram no `docs/architecture/README.md` (a da marca e a do
  `indice-de-atrito`, que faltava). As **três** instruções "re-renderize com archify" —
  `sistema-vivo.md` ×2 e a skill — foram corrigidas: o archify 2.11.0 recusa o formato.
- **Jornada nova** no `docs/testing/user-journey-map.md`, com a persona que faltava (o
  revendedor) e 8 casos. O TOTP **deixou de ter duas biografias**.
- **Catraca nova** `tests/unit/audit-listas-nao-divergem-mais.test.ts` — nasce verde,
  congela as 120 divergências e reprova acréscimo.
- **Números de CI corrigidos** em quatro arquivos (ver abaixo).

## Living System Checklist — marca própria (o épico inteiro)

Régua: `docs/doctrine/sistema-vivo.md`. Resposta que não nomeia artefato concreto não vale.

| # | Pergunta | Resposta, com o artefato |
|---|---|---|
| 1 | **Quem me alimenta?** | `hostgator-setup-kit/install.sh:1365-1379` grava a marca no `.env` → `sementeDoAmbiente()` (`lib/branding/instalacao.ts`) semeia `public.platform_branding` na primeira leitura. E a mão humana, por duas telas: `app/admin/(protected)/marca/_form.tsx` (instalação) e `app/app/settings/marca/_form.tsx` (organização) |
| 2 | **Quem eu alimento?** | `app/layout.tsx` (`<EstiloDaMarca/>` + `generateMetadata`), `app/app/layout.tsx` (`<EstiloDaMarcaDaOrganizacao/>`), `app/icon.tsx`, e via `marcaDaSaida()`: `lib/email/templates/invite.ts`, `lib/lgpd/email-delivery.ts`, `lib/lgpd/sla-alarm.ts`, `app/actions/auth/enrollMfa.ts` (`issuer`), `lib/email/resend.ts` (nome do remetente). Fora do processo: `hostgator-setup-kit/marca-emails.sh` → GoTrue |
| 3 | **Que atividade/log eu emito?** | `audit("platform_branding.updated")` em `app/actions/settings/updateBranding.ts:123` e `audit("org.branding_updated")` em `app/actions/settings/updateMarcaDaOrganizacao.ts:155` — as duas em `api_audit_log`, e **as duas presentes nas duas listas de código** (`lib/audit/actions.ts` e `components/admin/audit/action-codes.ts`). Mais `registrarEstadoDaMarca()`, que grava `fallback_at`/`fallback_reason` na própria tabela, e o `logger.warn` estruturado quando a cor é recusada. **Não há `event_log` de propósito:** nenhum handler consumiria o tipo (anti-pattern nº 3 — evento sem consumidor) |
| 4 | **Onde apareço na tela?** | `/admin/marca` (valor gravado + `TiraDeTons` com os tons derivados + o estado do degrade em português), `/app/settings/marca`, `/admin/audit` (as duas ações), a aba do navegador (título + ícone), a barra lateral e o corpo de cada e-mail |
| 5 | **Por qual porta se chega?** | `lib/navigation/registry.ts:453` — `/app/settings/marca`, grupo Configurações, `sidebar:false` (trocar a marca é tarefa de uma vez; o hub e o ⌘K garantem a descoberta). Vigiado por `tests/unit/navegacao-completude.test.ts`. `/admin/marca` é de platform admin e fica fora dessa varredura por construção |
| 6 | **Mecanismo anti-morte?** | Três, e nenhum é promessa: (a) cor recusada **não apaga a camada de baixo** — `resolverMarca()` continua descendo até o padrão do produto; (b) `marcaDaInstalacao()` e `marcaDaSaida()` **nunca lançam** (um throw em `app/layout.tsx` é 500 em todas as telas; um throw no e-mail de LGPD é descumprimento de prazo legal); (c) tabela ausente (`42P01`) degrada para o `.env` com aviso, que é o estado de um clone que ainda não aplicou a migration |
| 7 | **Onde se CONFIGURA?** | **Ver:** `/admin/marca` mostra o valor em vigor, de onde ele veio (banco, `.env` ou padrão) e **por que** foi recusado, se foi. **Mudar:** o formulário da mesma tela — e `/app/settings/marca` para a organização. **Faltando:** cai no padrão do produto com `fallback_reason` escrito, nunca num `return` mudo |
| 8 | **Continuidade IA↔humano?** | **N/A justificado.** A marca não participa de handoff: é configuração de apresentação, não demanda de atendimento. Nenhum turno de agente lê ou escreve marca |
| 9 | **Qual meu LAÇO DE RETORNO?** (invariante 7) | Quando a cor do operador **não** pinta, o sistema não fica calado: `app/layout.tsx` chama `registrarEstadoDaMarca(motivo)`, que grava `fallback_at` + `fallback_reason` **de volta** em `platform_branding`; `/admin/marca` lê e mostra; e o log estruturado nomeia o token e a forma recusada. É o que distingue "o produto ficou com a cor dele" de "a feature nunca foi instalada" — e é a única razão de isso ser **coluna**, não `logger.warn` |
| 10 | **Atualizei o mapa vivo?** | `docs/architecture/marca-propria.architecture.json` (37 peças / 54 arestas), linha no `docs/architecture/README.md`, e caso concreto em `tests/unit/mapas-de-arquitetura.test.ts` cobrando **≥2 arestas** de 8 peças nomeadas. **Sem re-render:** o archify 2.11.0 recusa o formato `architecture` — a instrução contrária foi corrigida em três lugares |

## Números de CI corrigidos (2026-08-14 @ `741c4ec8`)

| Onde | Dizia | Medido |
|---|---|---|
| `CLAUDE.md` (2 pontos) | "37 das 39 specs"; "Todos os **quatro**"; `imagens-ok` "ainda não é obrigatório" | **45 das 46**; **cinco**; `imagens-ok` **é** obrigatório |
| `AGENTS.md` (4 pontos) | "os três são checks"; "28 das 32"; "não é obrigatório ainda"; 221 unitários / 67 invariantes / 32 specs | **cinco**; **45 das 46**; **obrigatório desde 2026-08-08**; **257** / **102** / **46** |
| `docs/harness-audit.md` | "4 das 32 specs fora do CI, não-obrigatório" | **1 das 46**, obrigatório |
| `docs/current-state.md` (3 pontos) | "28 das 32"; "e2e não é obrigatório"; "`imagens-ok` ainda não está na branch protection" | **45 das 46**; obrigatório; `imagens-ok` entrou |

Comandos: `ls tests/e2e/*.spec.ts | wc -l` → 46 · parse das listas do `e2e.yml` → 45 rodam, 1
em `FORA_DO_CI` (`vps-fresh-onboarding`), soma == disco · `gh api …/branches/main/protection
--jq '.required_status_checks.contexts|join(", ")'` → `verify, build-and-size, invariants,
e2e, imagens-ok`.

## Dívida declarada — depois do épico

| # | Dívida | Condição para sair |
|---|---|---|
| D1 | Marca no **alarme de orçamento de IA** (`fase: 7` na guarda) | Ganhar rota em `app/api/v1/cron/`, linha no `docker/scheduler/entrypoint.sh` e chamador real de `runBudgetChecker()`. Hoje o efeito de consertar é **zero observável** |
| D2 | `white-label.md` em **EN/ES** | Um gate que reprove tradução defasada. Sem ele, três cópias divergem no primeiro conserto seguinte, e guia comercial errado em inglês é pior que ausente |
| D3 | **Upload de logo** (saiu do épico) e **fonte/tema** por tenant | Logo: bucket + policies + teto de 512 KB + delete-on-replace, com a cota do Supabase do cliente medida. Fonte/tema: exigiria `Font.register` e o arquivo dentro da imagem — o `next/font` resolve em build |
| D4 | As **120 divergências** entre `lib/audit/actions.ts` e o painel | O conserto certo é **derivar** a lista do union, não copiá-la melhor. A catraca nova impede crescer; encolher é item próprio |
| D5 | `docs/design-system/screen-flow/03-screen-inventory.md` — seção M diz "15 telas" e tem **17** linhas | Uma passada no inventário inteiro. Corrigir só uma linha deixa dois totais errados |
| D6 | `marca-emails.sh` não alcança quem instalou colando as 4 credenciais **sem** `SUPABASE_ACCESS_TOKEN` | Uma forma de o operador autorizar a Management API depois da instalação, sem guardar chave mestra no `.env` do cliente |
| D7 | `fallback_at` é **inalcançável pela UI** — o CHECK do banco barra o hex corrompido antes | Só aparece para quem edita o banco à mão ou vem de clone com valor legado. É o laço de retorno funcionando com gatilho raro, não ausente |
| D8 | Prova de **instalação fresca ponta a ponta com marca de revendedor** | Mesma lacuna de `vps-fresh-onboarding`: nenhum job prova a jornada de quem compra. É onde eu apostaria o próximo defeito de marca |

## Próximo passo exato

O épico está fechado no código e na documentação. Falta o que só o dono faz: **PR e merge na
`main`** — autorizado explicitamente por Rafael em 2026-08-13. Ao abrir o PR, o `e2e` roda pela
primeira vez a `tests/e2e/icone-da-marca.spec.ts`; se ela reprovar por ambiente, o lugar dela é
`FORA_DO_CI` **com o motivo medido**, nunca uma exclusão preventiva.

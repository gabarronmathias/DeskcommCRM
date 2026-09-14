# Instalar para clientes (agências e revendedores)

Guia para quem instala o G&M CRM **para outras empresas** — agência, consultoria, revendedor — e cobra por isso.

A licença é MIT: você pode modificar, hospedar para terceiros, revender e cobrar o que quiser. Não há royalty, não há cláusula proibindo hospedagem comercial e não existe versão paga que trave funcionalidade do seu cliente.

---

## Trocar a marca

**Pela tela, e sem reiniciar nada.** Em `/admin/marca` você troca o **nome do sistema** e a **cor da marca**. Salvou, recarregou, a interface inteira já está repintada — a barra lateral, os botões, o anel de foco, o título da aba e o ícone do navegador.

A cor é **derivada**, não aplicada crua: de um hex saem onze tons nos dois temas (claro e escuro), com um piso de contraste calculado por papel e por superfície. Se a cor que você escolheu ficaria ilegível como texto de botão no tema escuro, o sistema anda os degraus necessários e a tela **te mostra** em qual tom cada coisa vai pousar, antes de salvar. Nada de "escolhi amarelo e o botão ficou branco no branco".

O logo continua no `.env`:

```bash
APP_LOGO_URL=https://cdn.suaempresa.com.br/logo.svg
```

Sem ela, o nome aparece como texto na barra lateral. Com ela, o logo substitui o texto — altura fixa, largura livre, para não distorcer arte de proporção qualquer. **Ainda não há tela para o logo:** ele é o único dos três eixos que não se troca pelo painel.

### As três variáveis do `.env`, e o papel real delas

```bash
APP_NAME=Vendas Turbo CRM
APP_LOGO_URL=https://cdn.suaempresa.com.br/logo.svg
APP_ACCENT_HEX=#7a5cd6
```

O `install.sh` pergunta o `APP_NAME` e o grava (Enter mantém o padrão). `APP_LOGO_URL` e `APP_ACCENT_HEX` você edita à mão no `.env` — **o instalador não pergunta a cor**, porque o caminho normal dela é a tela.

> ⚠️ **`APP_ACCENT_HEX` posta à mão não sobrevive a uma nova execução do `install.sh`.** O instalador reescreve o `.env` inteiro do zero, e só as chaves que ele conhece são regravadas; `APP_ACCENT_HEX` não é uma delas. Isso **não** vale para `bash update.sh`, que edita o arquivo linha a linha e preserva o que você acrescentou. Na prática: defina a cor **pela tela**, que é onde ela persiste de verdade — o `.env` só importa como rede de rollback, e para a cor essa rede é vazia por construção (a variável nasceu neste épico, nenhuma versão anterior pinta accent).

O que essas variáveis são, exatamente: **semente e piso de rollback.**

- **Semente** — na primeira leitura, o que estiver no `.env` é gravado no banco. É assim que uma instalação nova já nasce com o seu nome.
- **Piso de rollback** — se você voltar para uma versão anterior do sistema, o `agent.sh` reverte a **imagem**, não o **banco**. A marca que sobrevive a qualquer volta é a que está no `.env`.

Depois da primeira leitura, **o banco manda**. Trocar a cor pela tela não pede `docker compose up -d`, não pede reinício, não pede nada: a leitura é feita a cada carregamento, com um cache curto que a própria tela invalida ao salvar.

### Por que isso é configuração, e não uma edição de código

Trocar a marca editando os arquivos-fonte funciona **uma vez**. No próximo `bash update.sh`, a imagem nova sobrescreve o patch e a marca do seu cliente volta a ser a nossa — normalmente sem ninguém perceber, até o cliente ver.

Configuração sobrevive a toda atualização. É por isso que a marca é lida em tempo de execução e nunca embutida na compilação: **uma única imagem Docker serve qualquer marca**. Pela mesma razão não existe "imagem com a sua marca": o `update.sh` regrava a linha `APP_IMAGE` do `.env` em toda atualização, e a sua imagem seria substituída pela nossa em silêncio, numa atualização de rotina.

---

## Marca por organização

**Uma instalação atende várias organizações, e cada uma pode ter a própria marca.** O admin de cada organização abre `Configurações → Marca` (`/app/settings/marca`) e define **nome** e **cor** dela — sem precisar de você, e sem enxergar as outras.

A fronteira, que é deliberada:

| Onde | Qual marca aparece |
|---|---|
| `/login`, cadastro, recuperação de senha, verificação em duas etapas | A da **instalação** (a sua) |
| Dentro do sistema (`/app/...`), depois de entrar | A da **organização**, se ela tiver; senão, a da instalação |
| E-mails de acesso (confirmação de conta, recuperação de senha) | A da **instalação** |
| Convite de time, e-mails de LGPD | A da **organização** que enviou |

O motivo de o login ficar de fora não é limitação: **antes de a pessoa entrar, o sistema não sabe de qual organização ela é.** Pintar o login com a cor de alguma delas seria escolher uma no escuro.

Isso não torna a instalação dedicada obsoleta — ver a comparação abaixo, que continua valendo por infra, isolamento e discurso de venda.

### O que ainda não é configurável

Sendo direto, para você não descobrir na frente do cliente. Cada linha traz a razão medida, não a desculpa:

- **Domínio por organização.** Uma instalação, um domínio. Não há coluna de domínio no schema, o desvio por host no `proxy.ts` é um NOOP declarado (existe só como documentação da topologia pretendida), e no Edge não há banco para consultar antes de decidir a quem aquele host pertence. Cliente que exige o próprio domínio pede **instalação dedicada**.
- **Fonte.** A tipografia é a mesma em toda instalação. `next/font` resolve em tempo de **build**, e a imagem que a sua VPS baixa já vem construída — um seletor de fonte no painel salvaria um valor que nada leria. (A fonte é a Atkinson Hyperlegible, escolhida pelo Braille Institute por legibilidade; trocá-la não muda percepção de marca e piora a leitura de quem passa o dia no sistema.)
- **Tema.** O par claro/escuro é do design system. A sua marca move o **accent** — o que é ação, destaque e foco —, e deliberadamente **não** move o fundo da página: o fundo é o mesmo em toda marca, e é por isso que a cor da barra do navegador também é.
- **Logo por organização.** O logo é da instalação, e só pelo `.env`.
- **O relatório de LGPD do titular não leva a sua marca — e isso é de propósito.** Ver a seção própria abaixo.
- **O alarme de orçamento de IA** ainda sai com a nossa marca. É o único vazamento conhecido, e ele fica: hoje esse alarme não tem agendamento nenhum ligado, então consertar a marca dele não mudaria nada que alguém veja. Sai quando o alarme ganhar cron de verdade.
- **Dois nomes técnicos não mudam**: o cabeçalho `X-G&M CRM-Signature` dos webhooks de saída e o cookie de sessão. O primeiro é contrato com sistemas de terceiros que já conferem esse nome; renomear derrubaria integração de cliente **em silêncio** — o receptor não dá erro, apenas deixa de reconhecer.

---

## Os e-mails

### Os e-mails de acesso — o primeiro artefato que o cliente do seu cliente recebe

Confirmação de conta e recuperação de senha **não são enviados pelo sistema**: quem os monta e dispara é o serviço de autenticação do Supabase. Nenhum código nosso roda ali dentro — é texto que precisa ser **empurrado** para lá por API.

Por isso o kit traz um script próprio:

```bash
bash hostgator-setup-kit/marca-emails.sh
```

Ele sobe o assunto e o corpo dos dois e-mails com o **seu** nome e a **sua** cor, e de quebra configura o endereço de retorno do link (que nenhum script configurava antes, e é pré-requisito do link funcionar). O `install.sh` o chama sozinho, logo depois de criar o projeto Supabase; o `update.sh` também o chama, para que uma instalação antiga receba isso na primeira atualização.

**Se ele não tiver a chave de acesso da API do Supabase** (`SUPABASE_ACCESS_TOKEN`), ele não falha e não derruba a instalação: imprime exatamente o que fazer à mão no painel do Supabase e sai com sucesso. Esse é o caso de quem criou o projeto pelo painel e colou as credenciais, em vez de deixar o instalador criá-lo.

> ⚠️ **Se for fazer à mão, atenção ao caractere.** O link do template precisa levar `&token_hash=`, com **`&`**, nunca `?`. Com `?` o endereço fica com dois pontos de interrogação, o sistema perde o token e o usuário cai numa tela dizendo que o link expirou — quando o problema é o template. Nesse caso o sistema agora **nomeia a causa** em vez de dizer só "link inválido".

### Convite de time e e-mails de LGPD

Saem com a marca da **organização** que os originou — porque quem processou a solicitação, no produto do seu cliente, é o sistema do seu cliente.

Para enviá-los, preencha as duas variáveis (o `install.sh` pergunta as duas):

```bash
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=nao-responda@suaempresa.com.br
```

**O endereço tem de ser de um domínio verificado na SUA conta Resend.** Esse é o único pedaço que a marca não resolve: o nome que aparece na caixa de entrada é a marca; o endereço é de quem hospeda.

**Deixar em branco é uma escolha suportada, não um defeito.** Sem elas, o sistema não tenta enviar e não falha calado: o convite mostra o link de aceite **na própria tela**, para você copiar e mandar por onde quiser, e o export de LGPD fica pendente de revisão em vez de sumir. Antes, um endereço em branco fazia todo envio falhar lá na Resend com uma mensagem opaca, e o operador ia caçar rede, contêiner e chave por causa de uma variável vazia.

### O endereço de suporte que os seus clientes veem

```bash
SUPPORT_EMAIL=suporte@suaempresa.com.br
```

Aparece nas telas de conta suspensa e de cobrança. **Vazio significa vazio:** a tela simplesmente não mostra endereço nenhum — nunca cai de volta no nosso. Numa tela de conta suspensa isso importa: quem suspendeu foi você, não nós.

---

## O relatório de LGPD é a única coisa que NÃO leva a sua marca

Quando um titular de dados exerce o direito do Art. 18 II, o sistema gera um relatório em PDF. Esse documento **não leva marca nenhuma** — nem a nossa, nem a sua, nem logo, nem cor. Ele nomeia o **controlador**: a razão social da organização, mais o encarregado (DPO).

Isso é decisão de produto, não item esquecido. Num documento que responde a um direito legal, quem é nomeado responde pelos dados. **Você é operador, não controlador.** Trocar o nome ali pela sua marca não seria "completar o whitelabel" — seria piorar: hoje o nome que aparecia era obviamente o do software, e depois pareceria a declaração de quem responde juridicamente pelos dados daquelas pessoas.

**O que isso te pede na instalação:** confira a **Razão social** de cada organização em `Configurações → Empresa`. Ela nasce igual ao nome fantasia (é o que o instalador tem para dar), e um nome fantasia impresso como razão social num documento jurídico é o tipo de erro que só aparece quando alguém reclama.

O e-mail que entrega o link do export é outra coisa e leva, sim, a marca da organização: ele diz quem **operou**. O PDF diz quem **responde**. São papéis diferentes, e é por isso que os dois carregam nomes diferentes.

---

## Um cliente por instalação, ou todos numa só?

O sistema é multi-tenant desde a primeira linha: uma instalação atende várias organizações, e o isolamento entre elas é verificado no CI a cada alteração — um usuário de uma organização não enxerga nenhuma linha de outra. Não é promessa de marketing: é o teste `tests/invariants/rls-isolation.test.ts`, que cria duas organizações e prova o não-vazamento pelo mesmo caminho de autenticação que a produção usa.

Mesmo assim, os dois modelos servem a propósitos diferentes:

| | Uma instalação por cliente | Uma instalação para todos |
|---|---|---|
| **Marca** | A de cada cliente, inclusive na tela de entrada | A sua no login; a de cada organização dentro do sistema |
| **Custo de infra** | Uma VPS por cliente | Uma VPS |
| **Falha** | Isolada | Atinge todos |
| **Atualização** | Uma por vez, pode escalonar | Todos de uma vez |
| **Dado do cliente** | Fisicamente separado | Separado por RLS |
| **Melhor para** | Revender com a marca do cliente | Sua própria operação atendendo várias contas |

Se o seu cliente pergunta "onde ficam meus dados?", a instalação dedicada tem a resposta mais simples de dar — e de defender.

---

## O argumento jurídico que fecha venda no Brasil

A **Resolução CD/ANPD nº 19/2024** tornou obrigatórias as cláusulas-padrão contratuais para **transferência internacional de dados pessoais**, com o prazo de adequação encerrado em **23 de agosto de 2025**.

Todo cliente seu que usa um CRM estrangeiro realiza essa transferência e precisa do artefato contratual. Hospedando em VPS no Brasil, **não há transferência internacional** — e a obrigação não se aplica.

⚠️ **Não venda como "servidor no Brasil = conformidade com a LGPD".** Isso é falso e um advogado desmonta na primeira pergunta: conformidade depende de base legal, finalidade, segurança e direitos do titular. O argumento correto e defensável é o de cima: sem transferência internacional, não há exigência de cláusulas-padrão.

---

## Operação

Cada instalação traz os scripts em `hostgator-setup-kit/`:

| Comando | O que faz |
|---|---|
| `bash update.sh` | Atualiza. Faz backup do banco **antes**, reaplica o schema de forma idempotente e confere a saúde no fim |
| `bash backup.sh` / `restore.sh` | Backup e restauração |
| `bash reset-password.sh` | Redefine a senha de um usuário |
| `bash reset-mfa.sh` | Remove a verificação em duas etapas de quem perdeu o aparelho |
| `bash healthcheck.sh` | Diagnóstico da instalação |

O `reset-mfa.sh` é o que você mais vai usar: a verificação em duas etapas é obrigatória para administradores, e trocar de celular sem salvar os códigos de recuperação é a chamada de suporte mais comum.

---

## Requisitos por instalação

**4 GB de RAM recomendados** (a stack sobe com 2 GB, mas opera no limite — o WAHA usa ~150 MB por sessão de WhatsApp), portas 80 e 443, Docker Compose v2 e um domínio com registro A apontando para o IP. A VPS não compila nada — baixa uma imagem pronta. O certificado HTTPS é emitido automaticamente no primeiro acesso.

Guia completo de instalação: [`hostgator-setup-kit/README.md`](../hostgator-setup-kit/README.md).

---

*Última atualização: 14 de agosto de 2026 — revisão completa depois do épico de marca própria. As duas frases mais citadas deste documento ("cores, fontes e tema não são configuráveis" e "a marca é por instalação, não por organização") deixaram de ser verdadeiras e foram reescritas com o limite honesto de hoje.*

*Este documento existe em português apenas. Os três READMEs (pt/en/es) apontam todos para ele. Tradução é dívida declarada, com pré-requisito nomeado: sem um gate que reprove tradução defasada, três cópias divergem no primeiro conserto seguinte — e um guia comercial errado em inglês é pior que um guia inexistente.*

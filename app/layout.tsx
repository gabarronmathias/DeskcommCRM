import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import { coresDaBarraDoNavegador } from "@/lib/branding/barra-do-navegador";
import { cssDaMarca } from "@/lib/branding/css";
import {
  marcaDaInstalacao,
  motivoDoFallback,
  registrarEstadoDaMarca,
  type LinhaDaMarca,
} from "@/lib/branding/instalacao";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import {
  camadaDaInstalacao,
  camadaDoAmbiente,
  resolverMarca,
  type MarcaResolvida,
} from "@/lib/branding/resolve";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ThemeProvider } from "@/lib/theme";
import { Providers } from "./providers";
import { PublicEnvScript } from "./public-env-script";
import "./globals.css";

/**
 * Par de fontes executivo p/ a marca Gabarron & Mathias: serif no display
 * (títulos, marca) + sans humanista no corpo. Mantém `--font-atkinson` como
 * alias para consumidores legados que ainda esperam a variável; a rampa do
 * `font-sans` Tailwind passa a ser IBM Plex Sans.
 */
const sourceSerif = Source_Serif_4({
  subsets: ["latin", "latin-ext"],
  weight: ["500", "600", "700"],
  display: "swap",
  variable: "--font-display",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-body",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

/** Alias de compatibilidade — `var(--font-atkinson)` ainda existe no css. */
const atkinson = {
  variable: "--font-atkinson",
  className: "",
};

/**
 * A pilha de camadas da marca da instalação: BANCO acima, `.env` embaixo.
 *
 * Uma função só porque `generateMetadata` e `EstiloDaMarca` precisam da MESMA
 * resolução — duas montagens da pilha divergiriam no dia em que a fase seguinte
 * acrescentar a camada da organização, e a divergência apareceria como título da
 * aba com uma marca e cor com outra.
 *
 * A leitura do banco é memoizada em `lib/branding/instalacao.ts`, então as duas
 * chamadas por requisição custam UMA consulta a cada TTL.
 */
async function marcaResolvida(): Promise<{
  /** A linha crua — só `EstiloDaMarca` precisa dela, para gravar o estado. */
  readonly linha: LinhaDaMarca | null;
  readonly marca: MarcaResolvida;
}> {
  const linha = await marcaDaInstalacao();
  const marca = resolverMarca(
    [camadaDaInstalacao(linha), camadaDoAmbiente(env)],
    REGUA_DO_PRODUTO,
  );
  return { linha, marca };
}

/**
 * Metadata dinâmica (não `export const metadata`) para a marca ser lida em RUNTIME.
 * Constante seria resolvida durante o `next build`, e a imagem self-host — que é
 * pré-buildada — carregaria a nossa marca para sempre. Ver `lib/branding.ts`.
 *
 * O `template` é o que faz a marca existir em UM lugar só: as páginas filhas
 * declaram apenas o próprio nome ("Entrar") e herdam o sufixo daqui.
 *
 * Passou a ler o BANCO (era `branding()`, só `.env`) porque senão `app_name` na
 * tabela seria coluna decorativa nesta fase: o operador trocaria o nome, a
 * gravação daria certo e a aba continuaria com o nome antigo. Os demais call
 * sites de `lib/branding` seguem no `.env` — está declarado no handoff, com o
 * motivo medido.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { marca } = await marcaResolvida();
  const { name } = marca;
  return {
    title: {
      default: `${name} — atendimento e vendas por WhatsApp com agentes de IA`,
      template: `%s · ${name}`,
    },
    description:
      "Centralize o atendimento por WhatsApp num funil só. Agentes de IA resolvem o que dá pra resolver e passam para o time humano o que importa — com tudo registrado. Multi-tenant, LGPD-nativo, feito para operações brasileiras.",
    applicationName: name,
    authors: [{ name }],
    keywords: [
      "CRM",
      "atendimento",
      "WhatsApp",
      "IA conversacional",
      "LGPD",
      "multi-tenant",
    ],
    robots: { index: false, follow: false },
    // Sem esta linha o navegador pede `/favicon.ico`, que não existe: medido em
    // produção, o 404 é a `app/not-found.tsx` INTEIRA (19.435 bytes de HTML)
    // servida para um pedido de ícone, em toda navegação sem cache. Declarar
    // `/icon` faz o pedido ir para `app/icon.tsx`, que desenha a marca da
    // instalação em runtime — ver o cabeçalho daquele arquivo para por que ele
    // não pode ser um arquivo estático em `public/`.
    icons: { icon: "/icon" },
  };
}

/**
 * A cor da barra do navegador sai da RÉGUA, não de dois hexes redigitados aqui.
 * O porquê — inclusive por que isto NÃO deve virar `generateViewport()` lendo o
 * banco — está no cabeçalho de `lib/branding/barra-do-navegador.ts`.
 */
export const viewport: Viewport = {
  themeColor: coresDaBarraDoNavegador(REGUA_DO_PRODUTO),
};

// Inline FOUC-prevention. Conteúdo é string literal estática (zero input do usuário),
// portanto seguro. Lê localStorage + prefers-color-scheme antes do primeiro paint.
const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem('gm-crm-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var r=(s==='dark'||s==='light')?s:((s==='system'||!s)&&d?'dark':'light');document.documentElement.setAttribute('data-theme',r);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

/**
 * Motivos já registrados neste processo. `EstiloDaMarca` roda em TODA
 * requisição e os motivos são os mesmos até alguém mudar o `.env` — repetir o
 * aviso a cada render seria ruído, e ruído é como um log deixa de ser lido.
 */
const motivosRegistrados = new Set<string>();

/**
 * A cor da instalação, injetada como CSS no `<head>`.
 *
 * É HTML no primeiro byte — antes do CSS e antes do `THEME_INIT_SCRIPT` — então
 * não há flash: o navegador nunca chega a pintar a cor do produto para depois
 * trocar. Server Component de propósito: a leitura é do BANCO e do `.env` em
 * runtime (a imagem self-host é pré-buildada; ver `lib/branding.ts`), e enviar
 * isso pelo cliente reintroduziria justamente o flash. Desde a migration 0155 a
 * fonte primária é `platform_branding`; o `.env` continua embaixo como semente —
 * e, para NOME e LOGO, como rede de rollback (ver `lib/branding/instalacao.ts`).
 * Para COR não existe rede: `APP_ACCENT_HEX` nasceu no mesmo épico que a tabela,
 * então nenhuma versão velha o bastante para desconhecê-la pinta accent, e o
 * `install.sh` não grava a chave (medido: 0 ocorrências, contra 7 de APP_NAME).
 * A correção está no cabeçalho da migration 0155.
 *
 * Os motivos NÃO morrem aqui: enquanto a tela de marca não existe (fase
 * seguinte, `/app/settings/tenant/branding`), o log estruturado é por onde o
 * operador descobre que a cor dele foi deslocada ou recusada — e `resolverMarca`
 * devolve a lista inteira para quem a quiser mostrar.
 */
async function EstiloDaMarca() {
  // `await headers()` força render dinâmico, pelo mesmo motivo do
  // `<PublicEnvScript/>`: numa imagem pré-buildada, um render ESTÁTICO
  // congelaria o valor lido durante o `next build` — que é vazio — e a cor do
  // revendedor nunca apareceria. Hoje o layout já é dinâmico por causa do
  // vizinho; declarar aqui torna a garantia local, em vez de depender de um
  // componente que alguém pode mover.
  await headers();
  const { linha, marca } = await marcaResolvida();
  const { css, motivos } = cssDaMarca(marca.cor);

  // O ESTADO da recusa vai para o banco, não só para o log. Sem isto, o degrade
  // ("o produto ficou com a cor dele") é indistinguível de "a feature nunca foi
  // instalada", e o operador conclui que o campo de cor não funciona.
  //
  // Sem `await`: gravar diagnóstico não pode atrasar — nem derrubar — a página
  // que o diagnóstico descreve. `registrarEstadoDaMarca` já não lança.
  void registrarEstadoDaMarca(linha, motivoDoFallback([...marca.motivos, ...motivos]));

  const avisos = [
    ...marca.motivos.map((m) => ({
      codigo: m.codigo,
      origem: m.origem,
      tema: m.tema,
      alvo: m.alvo,
      detalhe: m.detalhe,
    })),
    ...motivos.map((m) => ({
      codigo: m.codigo,
      origem: "css",
      tema: null,
      alvo: m.alvo,
      detalhe: m.detalhe,
    })),
  ];
  for (const aviso of avisos) {
    const chave = `${aviso.codigo}|${aviso.tema ?? ""}|${aviso.alvo ?? ""}`;
    if (motivosRegistrados.has(chave)) continue;
    motivosRegistrados.add(chave);
    logger.warn("marca da instalação: a cor configurada não foi aplicada como está", aviso);
  }

  // `null` sem motivo é o caso de fábrica (nenhuma cor configurada): não há o
  // que injetar, e o produto fica com a cor dele.
  if (!css) return null;
  // Conteúdo derivado do `.env` do servidor e já passado pela allowlist de forma
  // de `lib/branding/css.ts`, que recusa `<` e devolve `null` em vez de string
  // parcial. Mesmo contrato do `THEME_INIT_SCRIPT` acima.
  //
  // O `id` é o que torna este bloco IDENTIFICÁVEL na tela: sem ele, achá-lo no
  // `<head>` só dá por varredura de todos os `<style>` procurando um `--color-`
  // no texto (foi como a prova em tela deste marco teve de fazer), e distinguir
  // o bloco da INSTALAÇÃO do bloco da ORGANIZAÇÃO — que a fase seguinte injeta —
  // seria impossível. Vale para diagnóstico, para spec de e2e e para o suporte.
  return <style id="marca-instalacao" dangerouslySetInnerHTML={{ __html: css }} />;
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="pt-BR"
      data-theme="light"
      suppressHydrationWarning
      className={`${atkinson.variable} ${sourceSerif.variable} ${plexSans.variable} ${plexMono.variable}`}
    >
      <head>
        {/* Primeiro de tudo: a cor da instalação, antes do CSS e do script de tema. */}
        <EstiloDaMarca />
        {/* Config pública do Supabase em runtime (imagem genérica self-host). */}
        <PublicEnvScript />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-bg font-sans text-text antialiased">
        <Providers>
          <ThemeProvider>{children}</ThemeProvider>
          <Toaster
            position="top-right"
            richColors
            closeButton
            duration={4000}
          />
        </Providers>
      </body>
    </html>
  );
}

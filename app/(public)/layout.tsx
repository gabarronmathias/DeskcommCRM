import { branding, DEFAULT_APP_LOGO_URL } from "@/lib/branding";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  const brand = branding();
  const logoUrl = brand.logoUrl ?? DEFAULT_APP_LOGO_URL;

  return (
    <div className="gm-auth-shell min-h-screen p-3 sm:p-5">
      <div className="gm-auth-frame mx-auto grid min-h-[calc(100vh-1.5rem)] max-w-[1480px] overflow-hidden rounded-xl sm:min-h-[calc(100vh-2.5rem)] lg:grid-cols-[1.08fr_0.92fr]">
        <aside className="gm-auth-story hidden flex-col justify-between p-10 lg:flex xl:p-14">
          <div className="flex items-center gap-4">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="h-16 w-16 object-contain" />
            ) : (
              <div className="gm-auth-monogram">{brand.initial}</div>
            )}
            <div>
              <div className="gm-auth-brand-name">{brand.name}</div>
              <div className="gm-auth-brand-subtitle">Processos · tecnologia · performance</div>
            </div>
          </div>

          <div className="max-w-xl">
            <div className="gm-auth-eyebrow">Relacionamento, vendas e operação</div>
            <h1 className="gm-auth-title">
              Cada conversa sob <em>comando.</em>
            </h1>
            <p className="gm-auth-copy">
              Atendimento humano e inteligência artificial trabalhando no mesmo fluxo — com
              contexto, histórico e resultado visíveis em tempo real.
            </p>
          </div>

          <div className="gm-auth-footnote">
            <span>CRM de relacionamento e vendas</span>
            <span aria-hidden>•</span>
            <span>Gabarron & Mathias</span>
          </div>
        </aside>

        <main className="gm-auth-access flex items-center justify-center p-6 sm:p-10">
          <div className="gm-auth-card w-full max-w-md rounded-xl border p-6 shadow-xl sm:p-8">
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="" className="h-11 w-11 object-contain" />
              ) : null}
              <div>
                <div className="text-sm font-bold">{brand.name}</div>
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                  Central de comando
                </div>
              </div>
            </div>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

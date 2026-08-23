import Link from "next/link";

import { Card } from "@/components/ui/card";
import type { Role } from "@/lib/auth/types";
import { hubSections, type NavGroupId } from "@/lib/navigation/registry";
import type { WorkspaceProfile } from "@/lib/workspace/profile";

interface NavHubProps {
  group: NavGroupId;
  isPlatformAdmin: boolean;
  role: Role | null;
  workspaceProfile?: WorkspaceProfile;
  title: string;
  subtitle: string;
}

/**
 * Vitrine de um grupo do registro de navegação.
 *
 * O sidebar carrega o uso diário; o hub carrega o inventário — todas as telas
 * do grupo, cada uma com a frase que explica para que serve. Era isso que
 * faltava: telas como Conhecimento e Credenciais existiam só como aba dentro de
 * `/app/ai`, invisíveis para quem ainda não estava lá.
 *
 * As seções vêm do campo `section` do registro e são a JORNADA de quem usa o
 * grupo (montar → ensinar → acompanhar), não uma taxonomia técnica. Reordenar a
 * jornada é reordenar o array do registro.
 */
/**
 * `aria-labelledby` separa múltiplos ids por ESPAÇO — então um id com espaço
 * ("hub-ia-Ensinar o agente") vira três referências quebradas e a seção fica sem
 * rótulo acessível. O slug é o que mantém a região anunciável.
 */
function slug(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function NavHub({ group, isPlatformAdmin, role, workspaceProfile, title, subtitle }: NavHubProps) {
  const secoes = hubSections(group, isPlatformAdmin, role, workspaceProfile);

  return (
    <div className="flex h-full flex-col gap-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </header>

      {secoes.map(({ section, items }) => (
        <section key={section} aria-labelledby={`hub-${group}-${slug(section)}`} className="space-y-3">
          <h2
            id={`hub-${group}-${slug(section)}`}
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70"
          >
            {section}
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className="block">
                  <Card className="flex h-full gap-3 p-4 transition-colors hover:border-border-strong">
                    <Icon size={20} weight="regular" aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
                    <div>
                      <h3 className="text-sm font-semibold">{item.label}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

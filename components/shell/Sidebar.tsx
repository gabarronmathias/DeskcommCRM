"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import {
  Kanban,
  Users,
  UsersThree,
  Gear,
  CaretDoubleLeft,
  CaretDoubleRight,
  Inbox,
  ScalesSimple,
  Robot,
  Brain,
  PlugsConnected,
  ChartBar,
  ChartLineUp,
  WebhooksLogo,
  FlowArrow,
  FileText,
  ClockCountdown,
  PuzzlePiece,
  Signpost,
} from "@/lib/ui/icons";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { branding, DEFAULT_APP_LOGO_URL } from "@/lib/branding";

interface NavItem {
  href: string;
  label: string;
  icon: PhosphorIcon;
  permission?: string;
  healthDot?: boolean;
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Operação",
    items: [
      { href: "/app/inbox", label: "Inbox", icon: Inbox },
      { href: "/app/radar", label: "Radar", icon: ClockCountdown },
      { href: "/app/connections", label: "Conexões", icon: PlugsConnected, healthDot: true },
    ],
  },
  {
    label: "Relacionamento",
    items: [
      { href: "/app/kanban", label: "Kanban", icon: Kanban },
      { href: "/app/contacts", label: "Contatos", icon: Users },
      { href: "/app/team", label: "Equipe", icon: UsersThree },
      { href: "/app/metrics", label: "Desempenho", icon: ChartBar },
      { href: "/app/templates", label: "Templates", icon: FileText },
    ],
  },
  {
    label: "Inteligência",
    items: [
      { href: "/app/ai/agents", label: "Agentes IA", icon: Robot, permission: "ai.agents.view" },
      {
        href: "/app/ai/routers",
        label: "Roteadores",
        icon: Signpost,
        permission: "ai.routers.view",
      },
      {
        href: "/app/ai/followups",
        label: "Follow-ups",
        icon: FlowArrow,
        permission: "ai.agents.view",
      },
      { href: "/app/ai/memory", label: "Memória da IA", icon: Brain, permission: "ai.memory.view" },
      {
        href: "/app/ai/skills",
        label: "Skills da IA",
        icon: PuzzlePiece,
        permission: "ai.skills.view",
      },
      {
        href: "/app/ai/evolution",
        label: "Evolução da IA",
        icon: ChartLineUp,
        permission: "ai.evolution.view",
      },
    ],
  },
  {
    label: "Governança",
    items: [
      {
        href: "/app/lgpd/requests",
        label: "LGPD",
        icon: ScalesSimple,
        permission: "lgpd.execute_redact",
      },
      {
        href: "/app/webhooks",
        label: "Webhooks",
        icon: WebhooksLogo,
        permission: "webhooks.manage",
      },
      { href: "/app/settings", label: "Configurações", icon: Gear },
    ],
  },
];

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const canLgpd = usePermission("lgpd.execute_redact");
  const canAiAgents = usePermission("ai.agents.view");
  const canAiRouters = usePermission("ai.routers.view");
  const canAiMemory = usePermission("ai.memory.view");
  const canAiSkills = usePermission("ai.skills.view");
  const canAiEvolution = usePermission("ai.evolution.view");
  const canWebhooks = usePermission("webhooks.manage");

  const brand = branding();
  const logoUrl = brand.logoUrl ?? DEFAULT_APP_LOGO_URL;
  const canSee = (item: NavItem) => {
    if (item.permission === "lgpd.execute_redact") return canLgpd;
    if (item.permission === "ai.agents.view") return canAiAgents;
    if (item.permission === "ai.routers.view") return canAiRouters;
    if (item.permission === "ai.memory.view") return canAiMemory;
    if (item.permission === "ai.skills.view") return canAiSkills;
    if (item.permission === "ai.evolution.view") return canAiEvolution;
    if (item.permission === "webhooks.manage") return canWebhooks;
    return true;
  };

  return (
    <aside
      className={cn(
        "gm-sidebar fixed inset-y-0 left-0 z-30 flex flex-col border-r transition-[width] duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div
        className={cn(
          "gm-sidebar-brand flex h-20 items-center border-b px-3",
          collapsed ? "justify-center" : "gap-3",
        )}
      >
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt=""
            className={cn("shrink-0 object-contain", collapsed ? "h-9 w-9" : "h-12 w-12")}
          />
        ) : (
          <span aria-hidden className="gm-brand-initial">
            {brand.initial}
          </span>
        )}
        {!collapsed && (
          <div className="min-w-0">
            <div className="gm-brand-name truncate">{brand.name}</div>
            <div className="gm-brand-kicker">Central de comando</div>
          </div>
        )}
      </div>
      <nav className="gm-sidebar-nav flex-1 overflow-y-auto p-2" aria-label="Navegação principal">
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter(canSee);
          if (visibleItems.length === 0) return null;
          return (
            <div key={group.label} className="gm-nav-group">
              {!collapsed && <div className="gm-nav-group-label">{group.label}</div>}
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={collapsed ? item.label : undefined}
                      aria-current={isActive ? "page" : undefined}
                      data-active={isActive ? "true" : undefined}
                      className={cn(
                        "gm-nav-link relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                        collapsed && "justify-center px-2",
                      )}
                    >
                      <Icon size={18} weight={isActive ? "fill" : "regular"} aria-hidden />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                      {item.healthDot && (
                        <ConnectionHealthDot
                          className={cn(collapsed ? "absolute right-1.5 top-1.5" : "ml-auto")}
                        />
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="gm-sidebar-footer border-t p-2">
        <button
          type="button"
          onClick={() => startTransition(() => toggleSidebar(collapsed))}
          disabled={isPending}
          className={cn(
            "gm-sidebar-toggle flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs",
            collapsed && "justify-center px-2",
          )}
          aria-label={collapsed ? "Expandir sidebar" : "Recolher sidebar"}
        >
          {collapsed ? (
            <CaretDoubleRight size={14} aria-hidden />
          ) : (
            <CaretDoubleLeft size={14} aria-hidden />
          )}
          {!collapsed && <span>Recolher</span>}
        </button>
      </div>
    </aside>
  );
}

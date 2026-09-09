"use client";
import { AlertsBell } from "./AlertsBell";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar() {
  return (
    <header className="gm-topbar sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b px-6 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <span className="gm-command-label hidden lg:inline">Central de comando</span>
        <span aria-hidden className="gm-command-divider hidden h-4 w-px lg:block" />
        <TenantSwitcher />
      </div>
      <div className="flex flex-1 justify-center md:max-w-md">
        <SearchTrigger />
      </div>
      <div className="flex items-center gap-2">
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}

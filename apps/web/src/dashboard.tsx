"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { ChainPanel } from "./chain-panel";
import { DemoControl } from "./demo-control";
import { roles } from "./roles";

export function Dashboard({
  children,
  mode,
  demo,
  batcher,
}: {
  children: ReactNode;
  mode: string;
  demo: boolean;
  batcher?: string;
}) {
  const [query] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 1_000, retry: 1 } },
      }),
  );
  const pathname = usePathname();

  return (
    <QueryClientProvider client={query}>
      <header className="topbar">
        <div className="topbar-content">
          <Link className="brand" href="/" aria-label="ledgerA の役割選択">
            <span className="brand-emblem" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>ledgerA</span>
          </Link>
          {demo && <DemoControl />}
          <span className="environment">
            {mode === "anvil" ? "Anvil" : "DevNet"}
          </span>
        </div>
      </header>
      <nav className="role-nav" aria-label="役割">
        <div className="role-nav-content">
          {roles.map((role) => (
            <Link
              key={role.path}
              href={role.path}
              aria-current={pathname === role.path ? "page" : undefined}
            >
              {role.label}
            </Link>
          ))}
        </div>
      </nav>
      <div className="workspace">
        <main className="role-workspace" id="role-workspace">
          {children}
        </main>
        <ChainPanel demo={demo} batcher={batcher} />
      </div>
    </QueryClientProvider>
  );
}

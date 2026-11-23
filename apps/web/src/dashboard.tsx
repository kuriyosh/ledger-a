"use client";

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { api } from "./api";
import { roles } from "./roles";

type IndexStatus = {
  indexedBlock: string;
  unsafeBlock: string | null;
  safeBlock: string | null;
  finalizedBlock: string | null;
  enforcementEnabled: boolean;
  registryVersion: string;
};

const number = new Intl.NumberFormat("ja-JP");
const show = (value: string | null | undefined) =>
  value === null || value === undefined || value.startsWith("-")
    ? "—"
    : number.format(BigInt(value));

function NetworkPanel() {
  const index = useQuery({
    queryKey: ["indexer", "status"],
    queryFn: () => api<IndexStatus>("indexer", "/v1/status"),
    refetchInterval: 2_000,
  });
  const head = useQuery({
    queryKey: ["gateway", "log", "head"],
    queryFn: () => api<{ seq: string }>("gateway", "/v1/log/head"),
    refetchInterval: 2_000,
  });
  const status = index.data;

  return (
    <aside className="chain-panel" aria-label="チェーン表示">
      <div className="chain-heading">
        <h2>チェーン表示</h2>
        <span
          className={
            index.isError ? "connection connection-error" : "connection"
          }
        >
          {index.isError
            ? "接続を確認中"
            : index.isPending
              ? "取得中"
              : "接続中"}
        </span>
      </div>
      <div className="chain-content">
        <h3>ネットワーク</h3>
        <dl className="network-list">
          <div>
            <dt>取り込み済み</dt>
            <dd className="metric">{show(status?.indexedBlock)}</dd>
          </div>
          <div>
            <dt>最新ブロック</dt>
            <dd>{show(status?.unsafeBlock)}</dd>
          </div>
          <div>
            <dt>Safe</dt>
            <dd>{show(status?.safeBlock)}</dd>
          </div>
          <div>
            <dt>Finalized</dt>
            <dd>{show(status?.finalizedBlock)}</dd>
          </div>
          <div>
            <dt>登録規則</dt>
            <dd>
              {status ? (status.enforcementEnabled ? "有効" : "無効") : "—"}
            </dd>
          </div>
          <div>
            <dt>Registry バージョン</dt>
            <dd>{show(status?.registryVersion)}</dd>
          </div>
          <div>
            <dt>Gateway の最新通番</dt>
            <dd>{show(head.data?.seq)}</dd>
          </div>
        </dl>
        {head.isError && (
          <p className="notice">Gateway の通番を取得できません。</p>
        )}
      </div>
    </aside>
  );
}

export function Dashboard({
  children,
  mode,
}: {
  children: ReactNode;
  mode: string;
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
        <NetworkPanel />
      </div>
    </QueryClientProvider>
  );
}

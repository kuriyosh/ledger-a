"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";
import {
  displayAmount,
  ErrorNotice,
  jsonPost,
  Status,
  shortAddress,
} from "./ui";

type ChainStatus = {
  indexedBlock: string;
  unsafeBlock: string | null;
  safeBlock: string | null;
  finalizedBlock: string | null;
  enforcementEnabled: boolean;
  registryVersion: string;
};
type Call = {
  contract: string;
  function: string;
  args?: Record<string, unknown>;
  signer?: string;
  inner?: Call[];
};
type Tx = {
  hash: string;
  kind: string;
  type: string;
  from: string;
  to: string | null;
  value: string;
  timestamp: string;
  safety: string;
  status: string;
  call: Call | null;
  failure: { kind: string; errorName?: string } | null;
};
type Receipt = { txHash: string; seq: string };
type Registry = {
  address: string;
  vaspId: number;
  kind: number;
  status: number;
};
type Named = { address: string; familyName: string; givenName: string };
const tabs = [
  ["transactions", "取引"],
  ["registry", "登録簿"],
  ["l1", "L1"],
  ["network", "ネットワーク"],
] as const;
type Tab = (typeof tabs)[number][0];
const kinds: Record<string, string> = {
  TOKEN_TRANSFER: "送金",
  TOKEN_MINT: "発行",
  TOKEN_BURN: "償却",
  SWAP: "交換",
  REGISTRY_UPDATE: "登録の更新",
  SAFE_APPROVE: "承認",
  SAFE_EXECUTE: "実行",
  RECEIPT_COMMIT: "コミット",
  L1_ATTRIBUTES: "L1 属性",
  DEPOSIT: "Deposit",
  CONTRACT_DEPLOY: "コントラクト配備",
  OTHER: "その他",
};
const registryKind = ["未登録", "顧客", "自己勘定", "リレイヤー", "運営"];
const registryStatus = ["未登録", "有効", "停止", "遮断", "失効"];
const number = new Intl.NumberFormat("ja-JP");
const show = (value?: string | null) =>
  value && !value.startsWith("-") ? number.format(BigInt(value)) : "—";
const validAddress = (address?: string) =>
  Boolean(address && /^0x[\da-fA-F]{40}$/.test(address));

function calls(tx: Tx) {
  return tx.call?.inner ?? (tx.call ? [tx.call] : []);
}

function participants(tx: Tx) {
  const call = calls(tx).find((entry) =>
    ["transfer", "transferWithTravelRule", "mint", "burn", "fill"].includes(
      entry.function,
    ),
  );
  const to = typeof call?.args?.to === "string" ? call.args.to : tx.to;
  return { from: call?.signer ?? tx.from, to };
}

function amount(tx: Tx) {
  const token = calls(tx).find(
    (entry) =>
      ["tJPY", "tUSD"].includes(entry.contract) &&
      [
        "transfer",
        "transferWithTravelRule",
        "mint",
        "burn",
        "approve",
      ].includes(entry.function),
  );
  const value =
    token?.args?.amount ?? token?.args?.value ?? token?.args?._value;
  return typeof value === "string" && /^\d+$/.test(value)
    ? `${displayAmount(value)} ${token?.contract}`
    : null;
}

function TxDetail({ hash }: { hash: string }) {
  const detail = useQuery({
    queryKey: ["indexer", "tx", hash],
    queryFn: () =>
      api<Tx & { events: unknown[] }>("indexer", `/v1/txs/${hash}`),
    refetchInterval: 2_000,
  });
  const receipt = useQuery({
    queryKey: ["gateway", "receipt", hash],
    queryFn: async () => {
      const data = await api<{ receipts: Receipt[] }>(
        "gateway",
        "/v1/receipts/lookup",
        jsonPost({ txHashes: [hash] }),
      );
      return data.receipts[0] ?? null;
    },
  });
  return (
    <div className="tx-detail">
      <p>
        <code>{hash}</code>
      </p>
      <ErrorNotice error={detail.error ?? receipt.error} />
      {detail.data?.call && (
        <>
          <h3>呼び出し</h3>
          <pre>{JSON.stringify(detail.data.call, null, 2)}</pre>
        </>
      )}
      {detail.data?.failure && (
        <>
          <h3>失敗理由</h3>
          <pre>{JSON.stringify(detail.data.failure, null, 2)}</pre>
        </>
      )}
      {detail.data?.events.length ? (
        <>
          <h3>イベント</h3>
          <pre>{JSON.stringify(detail.data.events, null, 2)}</pre>
        </>
      ) : null}
      {receipt.data && (
        <>
          <h3>Receipt</h3>
          <pre>{JSON.stringify(receipt.data, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

function Transactions() {
  const [attributes, setAttributes] = useState(false);
  const [open, setOpen] = useState<string>();
  const list = useQuery({
    queryKey: ["indexer", "transactions"],
    queryFn: () => api<{ transactions: Tx[] }>("indexer", "/v1/txs?limit=50"),
    refetchInterval: 2_000,
  });
  const registry = useQuery({
    queryKey: ["indexer", "registry-catalog"],
    queryFn: () =>
      api<{ accounts: Registry[] }>(
        "indexer",
        "/v1/registry/accounts?limit=100",
      ),
    refetchInterval: 2_000,
  });
  const rows = (list.data?.transactions ?? []).filter(
    (row) => attributes || row.kind !== "L1_ATTRIBUTES",
  );
  const hashes = rows.map((row) => row.hash);
  const receipts = useQuery({
    queryKey: ["gateway", "receipts", hashes],
    queryFn: () =>
      api<{ receipts: Receipt[] }>(
        "gateway",
        "/v1/receipts/lookup",
        jsonPost({ txHashes: hashes }),
      ),
    enabled: hashes.length > 0,
    refetchInterval: 2_000,
  });
  const seqs = new Map(
    receipts.data?.receipts.map(({ txHash, seq }) => [
      txHash.toLowerCase(),
      seq,
    ]),
  );
  const catalog = new Map(
    registry.data?.accounts.map((entry) => [
      entry.address.toLowerCase(),
      entry,
    ]),
  );
  function party(address: string | null) {
    if (!address) return "—";
    const entry = catalog.get(address.toLowerCase());
    return (
      <span>
        <code title={address}>{shortAddress(address)}</code>
        {entry && (
          <small>
            {registryKind[entry.kind]} / VASP {entry.vaspId}
          </small>
        )}
      </span>
    );
  }
  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={attributes}
          onChange={(event) => setAttributes(event.target.checked)}
        />
        L1 属性取引を表示
      </label>
      {!rows.length && (
        <p className="notice">
          {list.isPending ? "取得中" : "取引がありません。"}
        </p>
      )}
      <ul className="tx-list">
        {rows.map((row) => {
          const people = participants(row);
          return (
            <li key={row.hash}>
              <button
                type="button"
                className="tx-summary"
                aria-expanded={open === row.hash}
                onClick={() =>
                  setOpen(open === row.hash ? undefined : row.hash)
                }
              >
                <span className="tx-line">
                  <strong>{kinds[row.kind] ?? row.kind}</strong>
                  <time dateTime={row.timestamp}>
                    {new Date(row.timestamp).toLocaleTimeString("ja-JP")}
                  </time>
                </span>
                <span className="tx-parties">
                  {party(people.from)}
                  <small className="party-label">宛先</small>
                  {party(people.to)}
                </span>
                <span className="tx-line">
                  <span>
                    {amount(row) ??
                      (row.type === "deposit"
                        ? "L1 経由"
                        : seqs.has(row.hash.toLowerCase())
                          ? `通番 ${seqs.get(row.hash.toLowerCase())}`
                          : "—")}
                  </span>
                  <span className="tx-meta">
                    {amount(row) &&
                      (row.type === "deposit"
                        ? "L1 経由"
                        : seqs.has(row.hash.toLowerCase())
                          ? `通番 ${seqs.get(row.hash.toLowerCase())}`
                          : null)}
                    <Status
                      value={row.status === "success" ? "成功" : "failed"}
                    />
                    <Status value={row.safety} />
                  </span>
                </span>
                {row.failure && (
                  <small>{row.failure.errorName ?? row.failure.kind}</small>
                )}
              </button>
              {open === row.hash && <TxDetail hash={row.hash} />}
            </li>
          );
        })}
      </ul>
      <ErrorNotice error={list.error ?? receipts.error} />
    </>
  );
}

function RegistryList({ demo }: { demo: boolean }) {
  const [all, setAll] = useState(!demo);
  const [names, setNames] = useState(false);
  const [after, setAfter] = useState<string>();
  const run = useQuery({
    queryKey: ["demo", "run"],
    queryFn: () => api<{ startBlock: string }>("demo", "/v1/demo/runs/current"),
    enabled: demo,
    retry: false,
    refetchInterval: 2_000,
  });
  const start = all ? undefined : run.data?.startBlock;
  const query = new URLSearchParams({
    limit: "30",
    ...(start && { registeredFromBlock: start }),
    ...(after && { after }),
  });
  const registry = useQuery({
    queryKey: ["indexer", "registry", query.toString()],
    queryFn: () =>
      api<{ accounts: Registry[]; nextAfter: string | null; partial: boolean }>(
        "indexer",
        `/v1/registry/accounts?${query}`,
      ),
    refetchInterval: 2_000,
  });
  const namesA = useQuery({
    queryKey: ["vasp-a", "registry-names"],
    queryFn: () => api<{ addresses: Named[] }>("vasp-a", "/v1/admin/addresses"),
    enabled: demo && names,
    refetchInterval: 2_000,
    gcTime: 0,
  });
  const namesB = useQuery({
    queryKey: ["vasp-b", "registry-names"],
    queryFn: () => api<{ addresses: Named[] }>("vasp-b", "/v1/admin/addresses"),
    enabled: demo && names,
    refetchInterval: 2_000,
    gcTime: 0,
  });
  const byAddress = new Map(
    [...(namesA.data?.addresses ?? []), ...(namesB.data?.addresses ?? [])].map(
      (entry) => [
        entry.address.toLowerCase(),
        `${entry.familyName} ${entry.givenName}`,
      ],
    ),
  );
  return (
    <>
      <div className="button-row">
        {demo && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={all}
              onChange={(event) => {
                setAll(event.target.checked);
                setAfter(undefined);
              }}
            />
            全期間
          </label>
        )}
        {demo && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={names}
              onChange={(event) => setNames(event.target.checked)}
            />
            氏名を表示
          </label>
        )}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>アドレス</th>
              <th>VASP</th>
              <th>種別</th>
              <th>状態</th>
              {names && <th>氏名（チェーンには載らない）</th>}
            </tr>
          </thead>
          <tbody>
            {registry.data?.accounts.map((entry) => (
              <tr key={entry.address}>
                <td>
                  <code title={entry.address}>
                    {shortAddress(entry.address)}
                  </code>
                </td>
                <td>{entry.vaspId}</td>
                <td>{registryKind[entry.kind]}</td>
                <td>{registryStatus[entry.status]}</td>
                {names && (
                  <td>{byAddress.get(entry.address.toLowerCase()) ?? "—"}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {registry.data?.partial && (
        <p className="small-note">取り込み開始以降の履歴を表示。</p>
      )}
      <div className="button-row">
        {after && (
          <button
            type="button"
            className="secondary"
            onClick={() => setAfter(undefined)}
          >
            先頭へ
          </button>
        )}
        {registry.data?.nextAfter && (
          <button
            type="button"
            className="secondary"
            onClick={() => setAfter(registry.data?.nextAfter ?? undefined)}
          >
            次へ
          </button>
        )}
      </div>
      <ErrorNotice
        error={
          registry.error ?? (names ? (namesA.error ?? namesB.error) : null)
        }
      />
    </>
  );
}

function L1({ status, batcher }: { status?: ChainStatus; batcher?: string }) {
  const deposits = useQuery({
    queryKey: ["indexer", "deposits"],
    queryFn: () =>
      api<{ transactions: Tx[] }>("indexer", "/v1/txs?kind=DEPOSIT&limit=10"),
    refetchInterval: 2_000,
  });
  return (
    <>
      <dl className="network-list">
        <div>
          <dt>Safe な L2 ブロック</dt>
          <dd>{show(status?.safeBlock)}</dd>
        </div>
        {validAddress(batcher) && (
          <div>
            <dt>Batcher</dt>
            <dd>
              <a
                href={`https://sepolia.etherscan.io/address/${batcher}`}
                rel="noreferrer"
                target="_blank"
              >
                Sepolia Etherscan
              </a>
            </dd>
          </div>
        )}
      </dl>
      <h3 className="subhead">Deposit の L2 取引</h3>
      <ul className="history">
        {deposits.data?.transactions.map((tx) => (
          <li key={tx.hash}>
            <code title={tx.hash}>{shortAddress(tx.hash)}</code>
            <Status value={tx.status} />
            {tx.failure && (
              <span>{tx.failure.errorName ?? tx.failure.kind}</span>
            )}
          </li>
        ))}
      </ul>
      <ErrorNotice error={deposits.error} />
    </>
  );
}

function Network({ status }: { status?: ChainStatus }) {
  const gateway = useQuery({
    queryKey: ["gateway", "status"],
    queryFn: () =>
      api<{
        lastSeq?: string;
        lastCommittedSeq?: string;
        queueLength?: number;
        leader?: string | null;
        sequencers?: {
          id: string;
          reachable: boolean;
          leader: boolean;
          active: boolean;
          healthy: boolean;
        }[];
      }>("gateway", "/v1/status"),
    refetchInterval: 2_000,
  });
  return (
    <>
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
          <dd>{show(gateway.data?.lastSeq)}</dd>
        </div>
        <div>
          <dt>コミット済み通番</dt>
          <dd>{show(gateway.data?.lastCommittedSeq)}</dd>
        </div>
        <div>
          <dt>転送待ち</dt>
          <dd>{gateway.data?.queueLength ?? "—"}</dd>
        </div>
      </dl>
      {gateway.data?.sequencers && (
        <>
          <h3 className="subhead">Sequencer</h3>
          <ul className="history">
            {gateway.data.sequencers.map((node) => (
              <li key={node.id}>
                <strong>{node.id}</strong>
                <span>
                  {node.id === gateway.data?.leader
                    ? "リーダー"
                    : node.reachable
                      ? "フォロワー"
                      : "—"}
                </span>
                <span>
                  {node.reachable && node.active && node.healthy
                    ? "稼働中"
                    : "停止または同期中"}
                </span>
              </li>
            ))}
          </ul>
          {!gateway.data.leader && <p className="notice">リーダーを確認中</p>}
        </>
      )}
      <ErrorNotice error={gateway.error} />
    </>
  );
}

export function ChainPanel({
  demo,
  batcher,
}: {
  demo: boolean;
  batcher?: string;
}) {
  const [tab, setTab] = useState<Tab>("transactions");
  const index = useQuery({
    queryKey: ["indexer", "status"],
    queryFn: () => api<ChainStatus>("indexer", "/v1/status"),
    refetchInterval: 2_000,
  });
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
      <fieldset className="chain-tabs">
        <legend className="visually-hidden">チェーンの表示</legend>
        {tabs.map(([key, label]) => (
          <button
            type="button"
            key={key}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <div className="chain-content">
        {tab === "transactions" && <Transactions />}
        {tab === "registry" && <RegistryList demo={demo} />}
        {tab === "l1" && <L1 status={index.data} batcher={batcher} />}
        {tab === "network" && <Network status={index.data} />}
      </div>
    </aside>
  );
}

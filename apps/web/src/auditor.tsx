"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api";
import {
  displayAmount,
  ErrorNotice,
  formData,
  jsonPost,
  Section,
  Status,
  shortAddress,
} from "./ui";

type Run = { run: number; startSeq: string; startBlock: string };
type Summary = {
  lastSeq: string;
  lastBlock: string | null;
  violations: number;
  exclusions: number;
  checks: Record<string, number>;
};
type ReceiptEntry = {
  receipt: {
    seq: string;
    receivedAtMs: string;
    txHash: string;
    sender: string;
  };
  position: { block: string; index: number } | null;
  checks: string[];
};
type Detail = {
  id?: number;
  seq?: string;
  type?: string;
  check?: string;
  reason?: string;
  detail?: string;
};
type Registry = {
  vaspId: number;
  kind: number;
  status: number;
  validUntil: string;
  version?: string;
  blockNumber?: string;
  actor?: string;
  txHash?: string;
};
type Balances = {
  blockNumber: string;
  balances: { tJPY: string; tUSD: string };
};
type Transfer = {
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  token: string;
  amount: string;
  blockNumber: string;
  travelRuleRef: string | null;
};
type Trace = Balances & {
  address: string;
  registry: Registry;
  history: Registry[];
  transfers: Transfer[];
};
type Disclosure = {
  id: string;
  status: string;
  disclosure?: {
    name: { primaryIdentifier: string; secondaryIdentifier: string };
  };
};
const registryStatus = ["未登録", "有効", "停止", "遮断", "失効"];
const registryKinds = ["未登録", "顧客", "自己勘定", "リレイヤー", "運営"];

function Evidence({ rows }: { rows: Detail[] }) {
  return (
    <ul className="record-list">
      {rows.map((item) => (
        <li key={item.id ?? item.seq}>
          <details>
            <summary>
              {[
                item.check,
                item.type ?? item.reason,
                item.seq && `通番 ${item.seq}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </summary>
            {item.detail && <p>{item.detail}</p>}
            <pre>{JSON.stringify(item, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function Fifo({ demo }: { demo: boolean }) {
  const [all, setAll] = useState(false);
  const [from, setFrom] = useState<string>();
  const cache = useQueryClient();
  const run = useQuery({
    queryKey: ["demo", "run"],
    queryFn: () => api<Run>("demo", "/v1/demo/runs/current"),
    enabled: demo,
    retry: false,
    refetchInterval: 2_000,
  });
  const current = !all ? run.data : undefined;
  const fromSeq = current?.startSeq ?? "1";
  const fromBlock = current?.startBlock ?? "0";
  const range = new URLSearchParams({ fromSeq, fromBlock });
  const query = <Data,>(part: string) =>
    api<Data>("auditor", `/v1/fifo/${part}?${range}`);
  const summary = useQuery({
    queryKey: ["auditor", "summary", fromSeq, fromBlock],
    queryFn: () => query<Summary>("summary"),
    refetchInterval: 2_000,
  });
  const entries = useQuery({
    queryKey: ["auditor", "entries", fromSeq, from],
    queryFn: () =>
      api<{ entries: ReceiptEntry[] }>(
        "auditor",
        `/v1/fifo/entries?${new URLSearchParams({ fromSeq: from ?? fromSeq, limit: "30" })}`,
      ),
    refetchInterval: 2_000,
  });
  const violations = useQuery({
    queryKey: ["auditor", "violations", fromSeq, fromBlock],
    queryFn: () => query<{ violations: Detail[] }>("violations"),
    refetchInterval: 2_000,
  });
  const exclusions = useQuery({
    queryKey: ["auditor", "exclusions", fromSeq],
    queryFn: () => query<{ exclusions: Detail[] }>("exclusions"),
    refetchInterval: 2_000,
  });
  const commitments = useQuery({
    queryKey: ["indexer", "receipt-commitments", fromBlock],
    queryFn: () =>
      api<{
        commitments: {
          args: { fromSeq: string; toSeq: string; headHash: string };
          txHash: string;
        }[];
      }>("indexer", "/v1/receipt-commitments?limit=20"),
    refetchInterval: 2_000,
  });
  const rerun = useMutation({
    mutationFn: () => api("auditor", "/v1/fifo/run", jsonPost()),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["auditor"] }),
  });
  const next = entries.data?.entries.at(-1)?.receipt.seq;
  return (
    <>
      <Section title="到着順の監査">
        <div className="button-row">
          {demo && run.data && (
            <button
              type="button"
              className="secondary"
              aria-pressed={!all}
              onClick={() => {
                setAll(false);
                setFrom(undefined);
              }}
            >
              この回
            </button>
          )}
          <button
            type="button"
            className="secondary"
            aria-pressed={!current}
            onClick={() => {
              setAll(true);
              setFrom(undefined);
            }}
          >
            全期間
          </button>
          <button
            type="button"
            disabled={rerun.isPending}
            onClick={() => rerun.mutate()}
          >
            再検査
          </button>
        </div>
        {current && (
          <p className="small-note">
            第 {current.run} 回 · 通番 {fromSeq} · ブロック {fromBlock} から
          </p>
        )}
        <ErrorNotice error={summary.error ?? rerun.error} />
        {summary.data && (
          <>
            <dl className="network-list">
              <div>
                <dt>検査済みの通番</dt>
                <dd>{summary.data.lastSeq}</dd>
              </div>
              <div>
                <dt>検査済みのブロック</dt>
                <dd>{summary.data.lastBlock ?? "—"}</dd>
              </div>
              <div>
                <dt>違反</dt>
                <dd>{summary.data.violations} 件</dd>
              </div>
              <div>
                <dt>除外</dt>
                <dd>{summary.data.exclusions} 件</dd>
              </div>
            </dl>
            <p className="small-note">
              {Object.entries(summary.data.checks)
                .map(([name, count]) => `${name} ${count} 件`)
                .join(" · ")}
            </p>
          </>
        )}
      </Section>
      <Section title="違反">
        {violations.data?.violations.length === 0 && <p>違反はありません。</p>}
        <Evidence rows={violations.data?.violations ?? []} />
        <ErrorNotice error={violations.error} />
      </Section>
      <Section title="Receipt">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>通番</th>
                <th>受付</th>
                <th>取引ハッシュ</th>
                <th>送信者</th>
                <th>取り込み</th>
                <th>判定</th>
              </tr>
            </thead>
            <tbody>
              {entries.data?.entries.map((entry) => (
                <tr
                  key={entry.receipt.seq}
                  className={
                    entry.checks.length ? "audit-violation" : undefined
                  }
                >
                  <td>{entry.receipt.seq}</td>
                  <td>
                    {new Date(
                      Number(entry.receipt.receivedAtMs),
                    ).toLocaleTimeString("ja-JP")}
                  </td>
                  <td>
                    <code title={entry.receipt.txHash}>
                      {shortAddress(entry.receipt.txHash)}
                    </code>
                  </td>
                  <td>
                    <code title={entry.receipt.sender}>
                      {shortAddress(entry.receipt.sender)}
                    </code>
                  </td>
                  <td>{entry.position?.block ?? "—"}</td>
                  <td>{entry.checks.join("、") || "適合"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="button-row">
          {from && (
            <button
              type="button"
              className="secondary"
              onClick={() => setFrom(undefined)}
            >
              先頭へ
            </button>
          )}
          {entries.data?.entries.length === 30 && next && (
            <button
              type="button"
              className="secondary"
              onClick={() => setFrom((BigInt(next) + 1n).toString())}
            >
              次へ
            </button>
          )}
        </div>
        <ErrorNotice error={entries.error} />
      </Section>
      <Section title="除外">
        {exclusions.data?.exclusions.length === 0 && <p>除外はありません。</p>}
        <Evidence rows={exclusions.data?.exclusions ?? []} />
        <ErrorNotice error={exclusions.error} />
      </Section>
      <Section title="コミット">
        <ul className="record-list">
          {commitments.data?.commitments
            .filter((row) => BigInt(row.args.toSeq) >= BigInt(fromSeq))
            .map((row) => (
              <li key={row.txHash}>
                <strong>
                  通番 {row.args.fromSeq}〜{row.args.toSeq}
                </strong>
                <p>
                  <code title={row.args.headHash}>
                    {shortAddress(row.args.headHash)}
                  </code>
                </p>
                <p>
                  取引{" "}
                  <code title={row.txHash}>{shortAddress(row.txHash)}</code>
                </p>
              </li>
            ))}
        </ul>
        <ErrorNotice error={commitments.error} />
      </Section>
    </>
  );
}

function AddressTrace({ address }: { address: string }) {
  const [block, setBlock] = useState<string>();
  const trace = useQuery({
    queryKey: ["auditor", "trace", address],
    queryFn: () => api<Trace>("auditor", `/v1/trace/${address}`),
    refetchInterval: 2_000,
  });
  const prior = useQuery({
    queryKey: ["auditor", "trace-balance", address, block],
    queryFn: () =>
      api<Balances>("auditor", `/v1/trace/${address}/balances?block=${block}`),
    enabled: block !== undefined,
  });
  const create = useMutation({
    mutationFn: (details: { reason: string; reasonCategory: string }) =>
      api<Disclosure>(
        "auditor",
        "/v1/disclosures",
        jsonPost({ address, ...details }),
      ),
  });
  const lookup = useQuery({
    queryKey: ["auditor", "disclosure", create.data?.id],
    queryFn: () =>
      api<Disclosure>("auditor", `/v1/disclosures/${create.data?.id}`),
    enabled: Boolean(create.data),
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data?.status === "pending" || !query.state.data
        ? 2_000
        : false,
  });
  const state = trace.data;
  const balances = block ? prior.data : state;
  const result = lookup.data?.disclosure;
  return (
    <>
      <ErrorNotice error={trace.error} />
      {state && (
        <>
          <Section title="登録情報">
            <p>
              <code className="audit-address">{state.address}</code>
            </p>
            <dl className="network-list">
              <div>
                <dt>所属 VASP</dt>
                <dd>{state.registry.vaspId}</dd>
              </div>
              <div>
                <dt>種別</dt>
                <dd>{registryKinds[state.registry.kind]}</dd>
              </div>
              <div>
                <dt>状態</dt>
                <dd>{registryStatus[state.registry.status]}</dd>
              </div>
              <div>
                <dt>有効期限</dt>
                <dd>
                  {state.registry.validUntil === "0"
                    ? "—"
                    : new Date(
                        Number(state.registry.validUntil) * 1000,
                      ).toLocaleString("ja-JP")}
                </dd>
              </div>
            </dl>
            <ul className="history">
              {state.history.map((item, index) => (
                <li key={item.txHash ? `${item.txHash}/${index}` : index}>
                  <span>
                    {registryStatus[item.status]} · ブロック {item.blockNumber}{" "}
                    · バージョン {item.version}
                  </span>
                  {item.actor && (
                    <code title={item.actor}>{shortAddress(item.actor)}</code>
                  )}
                </li>
              ))}
            </ul>
          </Section>
          <Section title="残高">
            <form
              className="form-grid"
              onSubmit={(event) =>
                setBlock(String(formData(event).get("block")) || undefined)
              }
            >
              <label>
                ブロック番号
                <input name="block" inputMode="numeric" pattern="[0-9]+" />
              </label>
              <div className="button-row">
                <button type="submit">残高を表示</button>
              </div>
            </form>
            {balances && (
              <div className="balance-grid">
                <div>
                  <span>tJPY</span>
                  <strong>{displayAmount(balances.balances.tJPY)}</strong>
                </div>
                <div>
                  <span>tUSD</span>
                  <strong>{displayAmount(balances.balances.tUSD)}</strong>
                </div>
              </div>
            )}
            {balances && (
              <p className="small-note">ブロック {balances.blockNumber}</p>
            )}
            <ErrorNotice error={prior.error} />
          </Section>
          <Section title="移転履歴">
            <ul className="record-list">
              {state.transfers.map((row) => (
                <li key={`${row.txHash}/${row.logIndex}`}>
                  <strong>{displayAmount(row.amount)}</strong>{" "}
                  <code title={row.token}>{shortAddress(row.token)}</code>
                  <p>
                    送信元{" "}
                    <code title={row.from}>{shortAddress(row.from)}</code> ·
                    宛先 <code title={row.to}>{shortAddress(row.to)}</code>
                  </p>
                  <p>
                    ブロック {row.blockNumber} · 取引{" "}
                    <code title={row.txHash}>{shortAddress(row.txHash)}</code>
                  </p>
                  {row.travelRuleRef && (
                    <p>
                      参照 ID{" "}
                      <code title={row.travelRuleRef}>
                        {shortAddress(row.travelRuleRef)}
                      </code>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Section>
          <Section title="氏名の開示">
            <p>
              {result
                ? `${result.name.primaryIdentifier} ${result.name.secondaryIdentifier}`
                : "非開示"}
            </p>
            {lookup.data && (
              <p>
                {lookup.data.status === "pending" ? (
                  "請求中"
                ) : (
                  <Status value={lookup.data.status} />
                )}
              </p>
            )}
            {!create.data && state.registry.vaspId > 0 && (
              <form
                className="form-grid"
                onSubmit={(event) => {
                  const data = formData(event);
                  create.mutate({
                    reason: String(data.get("reason")),
                    reasonCategory: String(data.get("category")),
                  });
                }}
              >
                <label>
                  理由の分類
                  <select name="category">
                    <option value="SUPERVISORY_REVIEW">監督上の確認</option>
                    <option value="AML_INVESTIGATION">AML 調査</option>
                    <option value="OTHER">その他</option>
                  </select>
                </label>
                <label className="full">
                  請求理由
                  <textarea name="reason" maxLength={500} required />
                </label>
                <div className="button-row full">
                  <button type="submit" disabled={create.isPending}>
                    開示を請求
                  </button>
                </div>
              </form>
            )}
            <ErrorNotice error={create.error ?? lookup.error} />
          </Section>
        </>
      )}
    </>
  );
}

export function Auditor({ demo }: { demo: boolean }) {
  const [tab, setTab] = useState<"fifo" | "trace">("fifo");
  const [address, setAddress] = useState<string>();
  return (
    <section className="role-picker">
      <h1>監査者</h1>
      <div className="button-row section-selector">
        <button
          type="button"
          aria-pressed={tab === "fifo"}
          onClick={() => setTab("fifo")}
        >
          到着順の監査
        </button>
        <button
          type="button"
          aria-pressed={tab === "trace"}
          onClick={() => setTab("trace")}
        >
          アドレス追跡
        </button>
      </div>
      {tab === "fifo" ? (
        <Fifo demo={demo} />
      ) : (
        <>
          <Section title="アドレス追跡">
            <form
              className="form-grid"
              onSubmit={(event) =>
                setAddress(String(formData(event).get("address")).trim())
              }
            >
              <label>
                アドレス
                <input name="address" pattern="0x[0-9a-fA-F]{40}" required />
              </label>
              <div className="button-row">
                <button type="submit">検索</button>
              </div>
            </form>
          </Section>
          {address && <AddressTrace key={address} address={address} />}
        </>
      )}
    </section>
  );
}

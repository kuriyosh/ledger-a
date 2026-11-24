"use client";

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "./api";
import { browserKey } from "./browser";
import {
  baseAmount,
  displayAmount,
  ErrorNotice,
  formData,
  jsonPost,
  Section,
  Status,
  shortAddress,
} from "./ui";

type Customer = {
  id: string;
  familyName: string;
  givenName: string;
  kycStatus: string;
  address: string | null;
};
type Approval = { memberId: number; txHash: string; blockNumber: string };
type Proposal = {
  id: string;
  type: string;
  params: Record<string, unknown>;
  reason: string;
  status: string;
  to: string;
  data: string;
  safeTxHash: string;
  safeNonce: string;
  approvals: Approval[];
  threshold: number;
  requestedBy: { vaspId?: number; memberId?: number };
  withdrawalRequest: { requestedAt: string; reason: string } | null;
  cancellation: { approvals: Approval[]; executedTxHash: string | null } | null;
};
type Alert = {
  id: string;
  customerId: string;
  transferId: string;
  address: string;
  rule: string;
  status: string;
  detail: { token: string; amount: string };
  proposalId: string | null;
  evidenceReorged: boolean;
  blockNumber: string;
};
type Travel = {
  refId: string;
  status: string;
  counterpartyVaspId: number;
  nameMatch: boolean | null;
  txHash: string | null;
  payload?: {
    amount: string;
    beneficiaryName?: {
      primaryIdentifier: string;
      secondaryIdentifier: string;
    };
  };
  message?: {
    amount: string;
    beneficiaryName?: {
      primaryIdentifier: string;
      secondaryIdentifier: string;
    };
  };
};
type Disclosure = {
  id: string;
  address: string;
  requestedBy: string;
  reason: string;
  status: string;
};
type RegistryStatus = {
  indexedBlock: string;
  safeBlock: string | null;
  finalizedBlock: string | null;
  registryVersion: string;
  enforcementEnabled: boolean;
};
const statusNames = ["未登録", "有効", "停止", "遮断", "失効"];
const adminTabs = [
  ["customers", "顧客"],
  ["received", "トラベルルール（受信）"],
  ["sent", "トラベルルール（送信）"],
  ["alerts", "アラート"],
  ["disclosures", "開示請求"],
] as const;
type AdminTab = (typeof adminTabs)[number][0];

function useAction(service: string) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; payload?: object }) =>
      api(service, input.path, jsonPost(input.payload)),
    onSuccess: () =>
      Promise.all([
        cache.invalidateQueries({ queryKey: [service] }),
        cache.invalidateQueries({ queryKey: ["indexer"] }),
      ]),
  });
}

export function safetyAt(block: string, chain?: RegistryStatus) {
  if (chain?.finalizedBlock && BigInt(block) <= BigInt(chain.finalizedBlock))
    return "finalized";
  if (chain?.safeBlock && BigInt(block) <= BigInt(chain.safeBlock))
    return "safe";
  return "unsafe";
}

function Customers({ service, demo }: { service: string; demo: boolean }) {
  const list = useQuery({
    queryKey: [service, "customers"],
    queryFn: () =>
      api<{ customers: Customer[] }>(service, "/v1/admin/customers"),
    refetchInterval: 2_000,
  });
  const [page, setPage] = useState(0);
  const [recipient, setRecipient] = useState<Customer>();
  const action = useAction(service);
  const mintIntent = useRef<{ details: string; key: string }>(undefined);
  const mint = useMutation({
    mutationFn: (input: {
      token: string;
      to: string;
      amount: string;
      key: string;
    }) =>
      api<{ txHash: string }>(
        "demo",
        "/v1/issuer/mint",
        jsonPost(
          {
            token: input.token,
            to: input.to,
            amount: baseAmount(input.amount),
          },
          { "Idempotency-Key": input.key },
        ),
      ),
    onSuccess: () => {
      mintIntent.current = undefined;
    },
  });
  const displayed = list.data?.customers.slice(page * 12, page * 12 + 12) ?? [];
  const registry = useQueries({
    queries: displayed.map(({ address }) => ({
      queryKey: ["indexer", "registry", address],
      queryFn: () =>
        api<{ account: { status: number } }>(
          "indexer",
          `/v1/registry/accounts/${address}`,
        ),
      enabled: Boolean(address),
      refetchInterval: 2_000,
    })),
  });
  return (
    <Section title="顧客">
      {displayed.length === 0 && (
        <p className="notice">
          {list.isPending ? "取得中" : "顧客がいません。"}
        </p>
      )}
      <ul className="record-list">
        {displayed.map((customer, index) => {
          const path = `/v1/admin/customers/${customer.id}`;
          const chain = registry[index].data?.account.status;
          return (
            <li key={customer.id}>
              <div className="record-title">
                <strong>
                  {customer.familyName} {customer.givenName}
                </strong>
                <code>{customer.id}</code>
              </div>
              <div className="button-row">
                <Status value={customer.kycStatus} />
                {customer.address && (
                  <code title={customer.address}>
                    {shortAddress(customer.address)}
                  </code>
                )}
                {customer.address && (
                  <span>
                    Registry {chain === undefined ? "—" : statusNames[chain]}
                  </span>
                )}
              </div>
              <div className="button-row">
                {["pending", "error"].includes(customer.kycStatus) && (
                  <>
                    <button
                      type="button"
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate({ path: `${path}/kyc/approve` })
                      }
                    >
                      承認
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate({ path: `${path}/kyc/reject` })
                      }
                    >
                      却下
                    </button>
                  </>
                )}
                {customer.kycStatus === "approved" && (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ path: `${path}/suspend` })}
                    >
                      停止
                    </button>
                    {demo && customer.address && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          mint.reset();
                          setRecipient(customer);
                        }}
                      >
                        入金（デモ）
                      </button>
                    )}
                  </>
                )}
                {customer.kycStatus === "suspended" && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ path: `${path}/reinstate` })}
                  >
                    停止を解除
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {(list.data?.customers.length ?? 0) > 12 && (
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            前へ
          </button>
          <button
            type="button"
            className="secondary"
            disabled={(page + 1) * 12 >= (list.data?.customers.length ?? 0)}
            onClick={() => setPage(page + 1)}
          >
            次へ
          </button>
        </div>
      )}
      {recipient?.address && (
        <form
          className="form-grid"
          onSubmit={(event) => {
            const data = formData(event);
            const to = recipient.address;
            if (!to || mint.isPending) return;
            const token = String(data.get("token"));
            const amount = String(data.get("amount"));
            const details = JSON.stringify([to, token, amount]);
            if (mintIntent.current?.details !== details) {
              mintIntent.current = { details, key: browserKey() };
            }
            mint.mutate({ token, amount, to, key: mintIntent.current.key });
          }}
        >
          <p className="full">
            入金先 {recipient.familyName} {recipient.givenName}
          </p>
          <label>
            トークン
            <select name="token">
              <option>tJPY</option>
              <option>tUSD</option>
            </select>
          </label>
          <label>
            金額
            <input name="amount" inputMode="decimal" required />
          </label>
          <div className="button-row full">
            <button type="submit" disabled={mint.isPending}>
              入金する
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setRecipient(undefined)}
            >
              閉じる
            </button>
          </div>
          {mint.data && (
            <p className="full" role="status">
              入金完了 <code>{shortAddress(mint.data.txHash)}</code>
            </p>
          )}
          <ErrorNotice error={mint.error} />
        </form>
      )}
      <ErrorNotice error={list.error ?? action.error} />
    </Section>
  );
}

function TravelRules({
  service,
  direction,
}: {
  service: string;
  direction: "in" | "out";
}) {
  const data = useQuery({
    queryKey: [service, "travel-rule", direction],
    queryFn: () =>
      api<{ messages: Travel[] }>(
        service,
        `/v1/admin/travel-rule?direction=${direction}`,
      ),
    refetchInterval: 2_000,
  });
  const action = useAction(service);
  return (
    <Section
      title={
        direction === "in" ? "受信したトラベルルール" : "送信したトラベルルール"
      }
    >
      {!data.data?.messages.length && (
        <p className="notice">申請がありません。</p>
      )}
      <ul className="record-list">
        {data.data?.messages.map((row) => {
          const payload = row.payload ?? row.message;
          const name = payload?.beneficiaryName;
          return (
            <li key={row.refId}>
              <div className="record-title">
                <strong>VASP {row.counterpartyVaspId}</strong>
                <Status value={row.status} />
              </div>
              <div className="button-row">
                {payload?.amount && (
                  <span>{displayAmount(payload.amount)}</span>
                )}
                {name && (
                  <span>
                    {name.primaryIdentifier} {name.secondaryIdentifier}
                  </span>
                )}
                {row.nameMatch !== null && (
                  <span>氏名照合 {row.nameMatch ? "一致" : "不一致"}</span>
                )}
                {row.txHash && (
                  <code title={row.txHash}>{shortAddress(row.txHash)}</code>
                )}
              </div>
              {direction === "in" && row.status === "pending" && (
                <div className="button-row">
                  <button
                    type="button"
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({
                        path: `/v1/admin/travel-rule/${row.refId}/approve`,
                      })
                    }
                  >
                    承認
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({
                        path: `/v1/admin/travel-rule/${row.refId}/reject`,
                      })
                    }
                  >
                    却下
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorNotice error={data.error ?? action.error} />
    </Section>
  );
}

function Alerts({ service }: { service: string }) {
  const data = useQuery({
    queryKey: [service, "alerts"],
    queryFn: () => api<{ alerts: Alert[] }>(service, "/v1/admin/alerts"),
    refetchInterval: 2_000,
  });
  const proposals = useQuery({
    queryKey: ["consortium", "proposals"],
    queryFn: () =>
      api<{ proposals: Proposal[] }>("consortium", "/v1/proposals"),
    enabled: Boolean(data.data?.alerts.some((row) => row.proposalId)),
    refetchInterval: 2_000,
  });
  const chain = useQuery({
    queryKey: ["indexer", "status"],
    queryFn: () => api<RegistryStatus>("indexer", "/v1/status"),
    refetchInterval: 2_000,
  });
  const action = useAction(service);
  return (
    <Section title="アラート">
      {!data.data?.alerts.length && (
        <p className="notice">アラートがありません。</p>
      )}
      <ul className="record-list">
        {data.data?.alerts.map((row) => {
          const proposal = proposals.data?.proposals.find(
            (item) => item.id === row.proposalId,
          );
          return (
            <li key={row.id}>
              <div className="record-title">
                <strong>
                  {row.rule === "LARGE_AMOUNT" ? "大口入金" : "氏名の一致"}
                </strong>
                <Status value={row.status} />
              </div>
              <p>
                {row.customerId} · {displayAmount(row.detail.amount)}{" "}
                {row.detail.token}
              </p>
              <p>
                根拠の入金{" "}
                <code title={row.transferId}>
                  {shortAddress(row.transferId)}
                </code>{" "}
                {row.status !== "invalidated" && !row.evidenceReorged && (
                  <span>{safetyAt(row.blockNumber, chain.data)}</span>
                )}
              </p>
              {row.evidenceReorged && (
                <p className="error-notice">根拠の入金が消えました。</p>
              )}
              {proposal && (
                <p>
                  凍結の承認 {proposal.approvals.length} / {proposal.threshold}
                </p>
              )}
              {row.status === "open" && (
                <div className="button-row">
                  <button
                    type="button"
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({
                        path: `/v1/admin/alerts/${row.id}/request-freeze`,
                      })
                    }
                  >
                    凍結を申請
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({
                        path: `/v1/admin/alerts/${row.id}/close`,
                      })
                    }
                  >
                    閉じる
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorNotice error={data.error ?? action.error} />
    </Section>
  );
}

function Disclosures({ service }: { service: string }) {
  const list = useQuery({
    queryKey: [service, "disclosures"],
    queryFn: () =>
      api<{ requests: Disclosure[] }>(service, "/v1/admin/disclosure-requests"),
    refetchInterval: 2_000,
  });
  const action = useAction(service);
  return (
    <Section title="開示請求">
      {!list.data?.requests.length && (
        <p className="notice">開示請求がありません。</p>
      )}
      <ul className="record-list">
        {list.data?.requests.map((row) => (
          <li key={row.id}>
            <div className="record-title">
              <code title={row.address}>{shortAddress(row.address)}</code>
              <Status value={row.status} />
            </div>
            <p>
              請求者{" "}
              {row.requestedBy === "auditor" ? "監査者" : row.requestedBy}
            </p>
            <p>{row.reason}</p>
            {row.status === "pending" && (
              <div className="button-row">
                <button
                  type="button"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/v1/admin/disclosure-requests/${row.id}/approve`,
                    })
                  }
                >
                  承認
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/v1/admin/disclosure-requests/${row.id}/reject`,
                    })
                  }
                >
                  却下
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ErrorNotice error={list.error ?? action.error} />
    </Section>
  );
}

export function VaspAdmin({ bank, demo }: { bank: "a" | "b"; demo: boolean }) {
  const [tab, setTab] = useState<AdminTab>("customers");
  const service = `vasp-${bank}`;
  return (
    <section className="role-picker">
      <h1>VASP {bank.toUpperCase()}</h1>
      <fieldset className="button-row section-selector">
        <legend className="visually-hidden">VASP の表示</legend>
        {adminTabs.map(([key, text]) => (
          <button
            type="button"
            key={key}
            className="secondary"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {text}
          </button>
        ))}
      </fieldset>
      {tab === "customers" && <Customers service={service} demo={demo} />}
      {tab === "received" && <TravelRules service={service} direction="in" />}
      {tab === "sent" && <TravelRules service={service} direction="out" />}
      {tab === "alerts" && <Alerts service={service} />}
      {tab === "disclosures" && <Disclosures service={service} />}
    </section>
  );
}

export function Consortium() {
  const [member, setMember] = useState(1);
  const listed = useQuery({
    queryKey: ["consortium", "proposals"],
    queryFn: () =>
      api<{ proposals: Proposal[] }>("consortium", "/v1/proposals"),
    refetchInterval: 2_000,
  });
  const registry = useQuery({
    queryKey: ["indexer", "vasps"],
    queryFn: () =>
      api<{ vasps: Array<{ vaspId: number; name: string; status: number }> }>(
        "indexer",
        "/v1/registry/vasps",
      ),
    refetchInterval: 2_000,
  });
  const state = useQuery({
    queryKey: ["indexer", "status"],
    queryFn: () => api<RegistryStatus>("indexer", "/v1/status"),
    refetchInterval: 2_000,
  });
  const action = useAction("consortium");
  return (
    <section className="role-picker">
      <h1>コンソーシアム</h1>
      <label className="member-control">
        操作する構成員
        <select
          value={member}
          onChange={(event) => setMember(Number(event.target.value))}
        >
          {[1, 2, 3].map((id) => (
            <option key={id} value={id}>
              構成員 {id}
            </option>
          ))}
        </select>
      </label>
      <Section title="申請">
        {!listed.data?.proposals.length && (
          <p className="notice">申請がありません。</p>
        )}
        <ul className="record-list">
          {listed.data?.proposals.map((row) => {
            const active = [
              "open",
              "executable",
              "failed",
              "cancelling",
            ].includes(row.status);
            const canExecute =
              ["executable", "failed"].includes(row.status) &&
              !row.withdrawalRequest;
            const send = (operation: string) =>
              action.mutate({
                path: `/v1/proposals/${row.id}/${operation}`,
                payload: { memberId: member },
              });
            return (
              <li key={row.id}>
                <div className="record-title">
                  <strong>
                    {row.type === "BLOCK_ACCOUNT" ? "アドレス凍結" : row.type}
                  </strong>
                  <Status value={row.status} />
                </div>
                <p>
                  申請者{" "}
                  {row.requestedBy.vaspId !== undefined
                    ? `VASP ${row.requestedBy.vaspId}`
                    : `構成員 ${row.requestedBy.memberId}`}{" "}
                  · 承認 {row.approvals.length} / {row.threshold}
                </p>
                <p>{row.reason}</p>
                {row.withdrawalRequest && (
                  <p className="error-notice">
                    取り下げ依頼 {row.withdrawalRequest.reason}
                  </p>
                )}
                {row.status === "cancelling" && (
                  <p>
                    取り下げの承認 {row.cancellation?.approvals.length ?? 0} /{" "}
                    {row.threshold}
                  </p>
                )}
                <details>
                  <summary>申請と承認の詳細</summary>
                  <dl className="detail-pairs">
                    <dt>対象</dt>
                    <dd>
                      <code title={row.to}>{shortAddress(row.to)}</code>
                    </dd>
                    <dt>Safe 取引</dt>
                    <dd>
                      <code title={row.safeTxHash}>
                        {shortAddress(row.safeTxHash)}
                      </code>
                    </dd>
                  </dl>
                  <pre>{JSON.stringify(row.params, null, 2)}</pre>
                  <ul>
                    {row.approvals.map((approval) => (
                      <li key={approval.memberId}>
                        構成員 {approval.memberId} · ブロック{" "}
                        {approval.blockNumber} ·{" "}
                        <code title={approval.txHash}>
                          {shortAddress(approval.txHash)}
                        </code>
                      </li>
                    ))}
                  </ul>
                </details>
                {active && (
                  <div className="button-row">
                    <button
                      type="button"
                      disabled={
                        action.isPending ||
                        row.status === "cancelling" ||
                        row.approvals.some((item) => item.memberId === member)
                      }
                      onClick={() => send("approve")}
                    >
                      承認
                    </button>
                    <button
                      type="button"
                      disabled={action.isPending || !canExecute}
                      onClick={() => send("execute")}
                    >
                      {row.status === "failed" ? "再実行" : "実行"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={action.isPending}
                      onClick={() => send("cancel")}
                    >
                      取り下げ
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <ErrorNotice error={listed.error ?? action.error} />
      </Section>
      <Section title="Registry">
        <p>
          規則{" "}
          {state.data ? (state.data.enforcementEnabled ? "有効" : "無効") : "—"}{" "}
          · バージョン {state.data?.registryVersion ?? "—"}
        </p>
        <ul className="record-list">
          {registry.data?.vasps.map((row) => (
            <li key={row.vaspId}>
              VASP {row.vaspId}　{row.name} ·{" "}
              {row.status === 1 ? "有効" : "停止"}
            </li>
          ))}
        </ul>
        <ErrorNotice error={registry.error ?? state.error} />
      </Section>
    </section>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api } from "./api";
import { browserKey } from "./browser";
import { ErrorNotice, jsonPost, Section } from "./ui";

const actions = [
  ["token-transfer", "L2 に直接トークン送金"],
  ["eth-transfer", "L2 に直接 ETH 送金"],
  ["deploy", "L2 に直接コントラクト配備"],
] as const;
type Action = (typeof actions)[number][0];
type Status = {
  address: string;
  registryStatus: number;
  enforcementEnabled: boolean;
  l1BalanceWei: string;
  l2BalanceWei: string;
  probeCount: string;
  maxFeePerGasWei: string;
  minFeePerGasWei: string;
  requiredWei: Record<Action, string>;
};
type Deposit = {
  l1TxHash: string;
  l1Status: string;
  l2TxHash: string | null;
  l2Status: string;
  l2BalanceWei: string;
  probeCountBefore: string;
  probeCountAfter: string;
};
type Submission = {
  accepted: boolean;
  txHash: string;
  error?: { code: number; message: string };
};
const resultLabels: Record<string, string> = {
  pending: "待機中",
  success: "成功",
  confirmed: "確認済み",
  failed: "失敗",
};
const prefix = "/v1/attacker";
const storageKey = "ledgera:last-enforcement-deposit";

function ether(text: string) {
  const unit = 10n ** 18n;
  const amount = BigInt(text);
  const tail = (amount % unit).toString().padStart(18, "0").replace(/0+$/, "");
  return [String(amount / unit), tail].filter(Boolean).join(".");
}

export function EnforcementDemo({ enabled }: { enabled: boolean }) {
  const cache = useQueryClient();
  const [history, setHistory] = useState<
    { id: string; label: string; result: Submission }[]
  >([]);
  const [hash, setHash] = useState<string>();
  const key = useRef<string>(undefined);
  const refresh = () =>
    cache.invalidateQueries({ queryKey: ["demo", "enforcement"] });
  const state = useQuery({
    queryKey: ["demo", "enforcement"],
    queryFn: () => api<Status>("demo", `${prefix}/status`),
    refetchInterval: 2_000,
    enabled,
  });
  const deposit = useMutation({
    mutationFn: () => {
      key.current ??= sessionStorage.getItem(storageKey) ?? browserKey();
      sessionStorage.setItem(storageKey, key.current);
      return api<Deposit>(
        "demo",
        `${prefix}/l1-deposit`,
        jsonPost(
          { mintEth: "0.001", action: "probe" },
          { "Idempotency-Key": key.current },
        ),
      );
    },
    onSuccess: (view) => setHash(view.l1TxHash),
  });
  const pending = useQuery({
    queryKey: ["demo", "enforcement-deposit", hash],
    queryFn: () => api<Deposit>("demo", `${prefix}/deposits/${hash}`),
    enabled: enabled && Boolean(hash),
    initialData: deposit.data,
    refetchInterval: (query) =>
      query.state.data?.l1Status === "failed" ||
      (query.state.data?.l2Status && query.state.data.l2Status !== "pending")
        ? false
        : 2_000,
  });
  const submit = useMutation({
    mutationFn: (input: {
      route: "direct" | "gateway";
      action: Action;
      label: string;
    }) =>
      api<Submission>(
        "demo",
        `${prefix}/l2-send`,
        jsonPost({ route: input.route, action: input.action }),
      ),
    onSuccess: (result, input) => {
      setHistory((old) =>
        [{ id: browserKey(), label: input.label, result }, ...old].slice(0, 20),
      );
      return refresh();
    },
  });
  const target = state.data;
  const current = pending.data;
  const ready = Boolean(
    target?.enforcementEnabled && target.registryStatus === 0,
  );
  const canSend = (action: Action) =>
    ready &&
    target &&
    BigInt(target.maxFeePerGasWei) >= BigInt(target.minFeePerGasWei) &&
    BigInt(target.l2BalanceWei) >= BigInt(target.requiredWei[action]);
  const depositRunning = Boolean(
    current && current.l1Status !== "failed" && current.l2Status === "pending",
  );
  return (
    <section className="role-picker">
      <h1>外部者</h1>
      {!enabled && <p className="notice">DevNet のデモ構成で利用できます。</p>}
      {enabled && (
        <>
          <Section title="デモアカウント">
            {target && (
              <>
                <p>
                  <code className="enforcement-address">{target.address}</code>
                </p>
                <dl className="network-list">
                  <div>
                    <dt>登録状態</dt>
                    <dd>
                      {target.registryStatus === 0 ? "未登録" : "登録済み"}
                    </dd>
                  </div>
                  <div>
                    <dt>Sepolia 残高</dt>
                    <dd>{ether(target.l1BalanceWei)} ETH</dd>
                  </div>
                  <div>
                    <dt>L2 残高</dt>
                    <dd>{ether(target.l2BalanceWei)} ETH</dd>
                  </div>
                  <div>
                    <dt>DepositProbe</dt>
                    <dd>{target.probeCount}</dd>
                  </div>
                  <div>
                    <dt>L2 手数料上限</dt>
                    <dd>{target.maxFeePerGasWei} wei / gas</dd>
                  </div>
                </dl>
              </>
            )}
            <ErrorNotice error={state.error} />
          </Section>
          <Section title="規則の確認">
            <div className="button-row">
              <button
                type="button"
                disabled={!ready || deposit.isPending || depositRunning}
                onClick={() => {
                  if (
                    current?.l2Status === "success" ||
                    current?.l2Status === "failed" ||
                    current?.l1Status === "failed"
                  ) {
                    sessionStorage.removeItem(storageKey);
                    key.current = undefined;
                  }
                  deposit.mutate();
                }}
              >
                L1 Deposit でカウンタを呼ぶ
              </button>
              {actions.map(([action, label]) => (
                <button
                  type="button"
                  className="secondary"
                  key={action}
                  disabled={!canSend(action) || submit.isPending}
                  onClick={() =>
                    submit.mutate({ route: "direct", action, label })
                  }
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="secondary"
                disabled={!canSend("token-transfer") || submit.isPending}
                onClick={() =>
                  submit.mutate({
                    route: "gateway",
                    action: "token-transfer",
                    label: "Gateway 経由で送金",
                  })
                }
              >
                Gateway 経由で送金
              </button>
            </div>
            {target && !canSend("token-transfer") && (
              <p className="small-note">
                送金に必要な残高 {ether(target.requiredWei["token-transfer"])}{" "}
                ETH。手数料の下限 {target.minFeePerGasWei} wei / gas。
              </p>
            )}
            <ErrorNotice
              error={deposit.error ?? pending.error ?? submit.error}
            />
          </Section>
          <Section title="結果">
            {current && (
              <div className="enforcement-output">
                <p>
                  L1 {resultLabels[current.l1Status]}{" "}
                  <code>{current.l1TxHash}</code>
                </p>
                <p>
                  L2 {resultLabels[current.l2Status]}{" "}
                  {current.l2TxHash && <code>{current.l2TxHash}</code>}
                </p>
                <p>
                  カウンタ {current.probeCountBefore} →{" "}
                  {current.probeCountAfter}
                </p>
                <p>L2 残高 {ether(current.l2BalanceWei)} ETH</p>
              </div>
            )}
            <ul className="record-list">
              {history.map(({ id, label, result }) => (
                <li className="enforcement-output" key={id}>
                  <strong>{label}</strong>
                  <p>
                    <code>{result.txHash}</code>
                  </p>
                  {result.accepted && <p>受付済み</p>}
                  {result.error && (
                    <>
                      {result.error.message.includes(
                        "ledgera: sender not allowed",
                      ) && <p>規則による拒否</p>}
                      <p>{result.error.message}</p>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </section>
  );
}

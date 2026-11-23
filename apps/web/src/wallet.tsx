"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api } from "./api";
import {
  baseAmount,
  displayAmount,
  ErrorNotice,
  formData,
  jsonPost,
  reason,
  Section,
  Status,
  shortAddress,
} from "./ui";

type Token = "tJPY" | "tUSD";
type Customer = {
  id: string;
  familyName: string;
  givenName: string;
  kycStatus: string;
  address: string | null;
};
type Operation = {
  id: string;
  status: string;
  gatewaySeq: string | null;
  txHash: string | null;
  errorCode: string | null;
  direction?: "in" | "out";
  amount?: string;
  token?: string;
};
type Quote = {
  quoteId: string;
  sellAmount: string;
  buyAmount: string;
  rate: string;
  expiresAt: string;
};
const terminal = new Set([
  "confirmed",
  "failed",
  "expired",
  "tr_rejected",
  "tr_expired",
]);
const symbols: Token[] = ["tJPY", "tUSD"];
const fields = (form: FormData) =>
  Object.fromEntries(
    [...form.entries()].map(([key, value]) => [key, String(value)]),
  );

function Login({
  bank,
  demo,
  onSession,
}: {
  bank: "a" | "b";
  demo: boolean;
  onSession: (token: string) => void;
}) {
  const service = `vasp-${bank}`;
  const [mode, setMode] = useState<"login" | "open">("login");
  const [email, setEmail] = useState<string>();
  const run = useQuery({
    queryKey: ["demo", "run"],
    enabled: demo,
    queryFn: () =>
      api<{ emailSuffix: string }>("demo", "/v1/demo/runs/current"),
    retry: false,
    refetchInterval: 2_000,
  });
  const suggested = run.data
    ? `${bank === "a" ? "sato" : "lim"}${run.data.emailSuffix}`
    : "";
  const login = useMutation({
    mutationFn: async (input: Record<string, string>) => {
      if (mode === "open") await api(service, "/v1/customers", jsonPost(input));
      return api<{ token: string }>(
        service,
        "/v1/session",
        jsonPost({ email: input.email }),
      );
    },
    onSuccess: (data) => onSession(data.token),
  });
  return (
    <Section title={mode === "login" ? "ログイン" : "口座開設"}>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          aria-pressed={mode === "login"}
          onClick={() => {
            login.reset();
            setMode("login");
          }}
        >
          ログイン
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={mode === "open"}
          onClick={() => {
            login.reset();
            setMode("open");
          }}
        >
          口座開設
        </button>
      </div>
      <form
        className="form-grid"
        onSubmit={(event) => login.mutate(fields(formData(event)))}
      >
        {mode === "open" && (
          <>
            <label>
              姓<input name="familyName" required />
            </label>
            <label>
              名<input name="givenName" required />
            </label>
            <label>
              生年月日
              <input name="dateOfBirth" type="date" required />
            </label>
            <label>
              国
              <select name="country" defaultValue={bank === "a" ? "JP" : "SG"}>
                <option value="JP">日本</option>
                <option value="SG">シンガポール</option>
              </select>
            </label>
            <label className="full">
              住所
              <input name="addressLine" required />
            </label>
          </>
        )}
        <label className="full">
          メールアドレス
          <input
            name="email"
            type="email"
            value={email ?? suggested}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <div className="full button-row">
          <button type="submit" disabled={login.isPending}>
            {mode === "open" ? "申請する" : "ログイン"}
          </button>
        </div>
      </form>
      <ErrorNotice error={login.error} />
    </Section>
  );
}

function Progress({
  service,
  path,
  first,
  headers,
}: {
  service: string;
  path: string;
  first: Operation;
  headers: HeadersInit;
}) {
  const result = useQuery({
    queryKey: [
      service,
      "wallet",
      new Headers(headers).get("Authorization"),
      path,
      first.id,
    ],
    queryFn: () => api<Operation>(service, `${path}/${first.id}`, { headers }),
    initialData: first,
    refetchInterval: (query) =>
      terminal.has(query.state.data?.status ?? "") ? false : 1_000,
  });
  const row = result.data;
  return (
    <div className="operation" aria-live="polite">
      <Status value={row.status} />
      {row.gatewaySeq && <span>通番 {row.gatewaySeq}</span>}
      {row.txHash && <code title={row.txHash}>{shortAddress(row.txHash)}</code>}
      {row.errorCode && <span>{reason(row.errorCode)}</span>}
      <ErrorNotice error={result.error} />
    </div>
  );
}

function TransferForm({
  service,
  headers,
  demo,
  busy,
}: {
  service: string;
  headers: HeadersInit;
  demo: boolean;
  busy: boolean;
}) {
  const cache = useQueryClient();
  const transfer = useMutation({
    mutationFn: (input: { form: Record<string, string>; skip: boolean }) => {
      const { form, skip } = input;
      return api<Operation>(
        service,
        "/v1/me/transfers",
        jsonPost(
          {
            toAddress: form.address,
            token: form.token,
            amount: baseAmount(form.amount),
            ...(form.familyName || form.givenName
              ? {
                  beneficiaryName: {
                    primaryIdentifier: form.familyName,
                    secondaryIdentifier: form.givenName,
                  },
                }
              : {}),
            ...(skip && { demo: { skipChecks: true } }),
          },
          headers,
        ),
      );
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: [service, "wallet"] }),
  });
  return (
    <Section title="送金">
      <form
        className="form-grid"
        onSubmit={(event) => {
          const submitter = (event.nativeEvent as SubmitEvent)
            .submitter as HTMLButtonElement | null;
          transfer.mutate({
            form: fields(formData(event)),
            skip: submitter?.value === "skip",
          });
        }}
      >
        <label className="full">
          宛先アドレス
          <input name="address" placeholder="0x…" required />
        </label>
        <label>
          受取人の姓
          <input name="familyName" />
        </label>
        <label>
          受取人の名
          <input name="givenName" />
        </label>
        <label>
          トークン
          <select name="token">
            {symbols.map((symbol) => (
              <option key={symbol}>{symbol}</option>
            ))}
          </select>
        </label>
        <label>
          金額
          <input name="amount" inputMode="decimal" required />
        </label>
        <div className="full button-row">
          <button type="submit" disabled={busy || transfer.isPending}>
            送る
          </button>
          {demo && (
            <button
              type="submit"
              value="skip"
              className="secondary"
              disabled={busy || transfer.isPending}
            >
              確認を飛ばして送る
            </button>
          )}
          <span className="small-note">手数料 0 円</span>
        </div>
      </form>
      <ErrorNotice error={transfer.error} />
      {transfer.data && (
        <Progress
          key={transfer.data.id}
          service={service}
          path="/v1/me/transfers"
          first={transfer.data}
          headers={headers}
        />
      )}
    </Section>
  );
}

function SwapForm({
  service,
  headers,
  demo,
  busy,
}: {
  service: string;
  headers: HeadersInit;
  demo: boolean;
  busy: boolean;
}) {
  const cache = useQueryClient();
  const [sell, setSell] = useState<Token>("tJPY");
  const buy = sell === "tJPY" ? "tUSD" : "tJPY";
  const [time, setTime] = useState(0);
  const quote = useMutation({
    mutationFn: ({ token, amount }: { token: Token; amount: string }) =>
      api<Quote>(
        service,
        "/v1/me/swaps/quote",
        jsonPost(
          {
            sellToken: token,
            buyToken: token === "tJPY" ? "tUSD" : "tJPY",
            buyAmount: baseAmount(amount),
          },
          headers,
        ),
      ),
    onSuccess: () => setTime(Date.now()),
  });
  const execute = useMutation({
    mutationFn: (input: { quoteId: string; expired: boolean }) =>
      api<Operation>(
        service,
        "/v1/me/swaps",
        jsonPost(
          {
            quoteId: input.quoteId,
            ...(input.expired && { demo: { allowExpired: true } }),
          },
          headers,
        ),
      ),
    onSuccess: () => cache.invalidateQueries({ queryKey: [service, "wallet"] }),
  });
  useEffect(() => {
    if (!quote.data) return;
    const timer = setInterval(() => setTime(Date.now()), 250);
    return () => clearInterval(timer);
  }, [quote.data]);
  const offer = quote.data;
  const seconds = offer
    ? Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - time) / 1_000))
    : 0;

  return (
    <Section title="交換">
      <form
        className="form-grid"
        onSubmit={(event) => {
          const input = fields(formData(event));
          execute.reset();
          quote.mutate({ token: sell, amount: input.amount });
        }}
      >
        <label>
          売るトークン
          <select
            value={sell}
            disabled={quote.isPending || execute.isPending}
            onChange={(event) => {
              setSell(event.target.value as Token);
              quote.reset();
            }}
          >
            {symbols.map((symbol) => (
              <option key={symbol}>{symbol}</option>
            ))}
          </select>
        </label>
        <label>
          買う金額（{buy}）<input name="amount" inputMode="decimal" required />
        </label>
        <div className="full button-row">
          <button type="submit" disabled={busy || quote.isPending}>
            見積もりを取得
          </button>
        </div>
      </form>
      <ErrorNotice error={quote.error} />
      {offer && (
        <div className="quote">
          <p>
            {displayAmount(offer.sellAmount)} {sell} を支払い、
            {displayAmount(offer.buyAmount)} {buy} を受け取る
          </p>
          <p>
            1 tUSD = {offer.rate} tJPY · 残り {seconds} 秒
          </p>
          <div className="button-row">
            <button
              type="button"
              disabled={
                seconds === 0 ||
                busy ||
                execute.isPending ||
                Boolean(execute.data)
              }
              onClick={() =>
                execute.mutate({ quoteId: offer.quoteId, expired: false })
              }
            >
              実行する
            </button>
            {demo && (
              <button
                type="button"
                className="secondary"
                disabled={
                  seconds > 0 ||
                  busy ||
                  execute.isPending ||
                  Boolean(execute.data)
                }
                onClick={() =>
                  execute.mutate({ quoteId: offer.quoteId, expired: true })
                }
              >
                期限切れの見積もりで実行
              </button>
            )}
          </div>
        </div>
      )}
      <ErrorNotice error={execute.error} />
      {execute.data && (
        <Progress
          key={execute.data.id}
          service={service}
          path="/v1/me/swaps"
          first={execute.data}
          headers={headers}
        />
      )}
    </Section>
  );
}

function Account({
  bank,
  token,
  demo,
  signOut,
}: {
  bank: "a" | "b";
  token: string;
  demo: boolean;
  signOut: () => void;
}) {
  const service = `vasp-${bank}`;
  const headers = { Authorization: `Bearer ${token}` };
  const me = useQuery({
    queryKey: [service, "wallet", token, "profile"],
    queryFn: () => api<Customer>(service, "/v1/me", { headers }),
    refetchInterval: 2_000,
    retry: false,
  });
  const ready = me.data?.kycStatus === "approved" && Boolean(me.data.address);
  const balances = useQuery({
    queryKey: [service, "wallet", token, "balances"],
    queryFn: () =>
      api<Record<Token, string>>(service, "/v1/me/balances", { headers }),
    enabled: ready,
    refetchInterval: 2_000,
  });
  const transfers = useQuery({
    queryKey: [service, "wallet", token, "transfers"],
    queryFn: () =>
      api<{ transfers: Operation[] }>(service, "/v1/me/transfers?limit=12", {
        headers,
      }),
    enabled: ready,
    refetchInterval: 2_000,
  });
  const swaps = useQuery({
    queryKey: [service, "wallet", token, "swaps"],
    queryFn: () =>
      api<{ swaps: Operation[] }>(service, "/v1/me/swaps?limit=12", {
        headers,
      }),
    enabled: ready,
    refetchInterval: 2_000,
  });
  const busy = Boolean(
    transfers.data?.transfers.some(
      (row) =>
        row.direction === "out" &&
        [
          "tr_pending",
          "tr_approved",
          "submitting",
          "submitted",
          "pending",
        ].includes(row.status),
    ) ||
      swaps.data?.swaps.some((row) =>
        ["submitting", "submitted"].includes(row.status),
      ),
  );
  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) signOut();
  }, [me.error, signOut]);
  return (
    <>
      <div className="account-bar">
        <div>
          <strong>
            {me.data ? `${me.data.familyName} ${me.data.givenName}` : "口座"}
          </strong>
          {me.data && <Status value={me.data.kycStatus} />}
        </div>
        <button type="button" className="secondary" onClick={signOut}>
          ログアウト
        </button>
      </div>
      <ErrorNotice error={me.error} />
      {ready && me.data?.address && (
        <>
          <Section title="残高">
            <div className="balance-grid">
              {symbols.map((symbol) => (
                <div key={symbol}>
                  <span>{symbol}</span>
                  <strong>{displayAmount(balances.data?.[symbol])}</strong>
                </div>
              ))}
            </div>
            <div className="button-row address-row">
              <code title={me.data.address}>
                {shortAddress(me.data.address)}
              </code>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  navigator.clipboard.writeText(me.data?.address ?? "")
                }
              >
                アドレスをコピー
              </button>
            </div>
            <ErrorNotice error={balances.error} />
          </Section>
          <TransferForm
            service={service}
            headers={headers}
            demo={demo}
            busy={busy}
          />
          <SwapForm
            service={service}
            headers={headers}
            demo={demo}
            busy={busy}
          />
          <Section title="履歴">
            {!(
              transfers.data?.transfers.length || swaps.data?.swaps.length
            ) && <p className="notice">取引はまだありません。</p>}
            <ul className="history">
              {transfers.data?.transfers.map((row) => (
                <li key={row.id}>
                  <span>
                    {row.direction === "in" ? "入金" : "送金"}{" "}
                    {row.amount && displayAmount(row.amount)} {row.token}
                  </span>
                  <Status value={row.status} />
                  {row.errorCode && <span>{reason(row.errorCode)}</span>}
                </li>
              ))}
              {swaps.data?.swaps.map((row) => (
                <li key={row.id}>
                  <span>交換</span>
                  <Status value={row.status} />
                  {row.errorCode && <span>{reason(row.errorCode)}</span>}
                </li>
              ))}
            </ul>
            <ErrorNotice error={transfers.error ?? swaps.error} />
          </Section>
        </>
      )}
    </>
  );
}

export function Wallet({ bank, demo }: { bank: "a" | "b"; demo: boolean }) {
  const key = `ledgera:wallet:${bank}`;
  const cache = useQueryClient();
  const [token, setToken] = useState<string | null>();
  useEffect(() => {
    setToken(sessionStorage.getItem(key));
  }, [key]);
  function signIn(value: string) {
    sessionStorage.setItem(key, value);
    setToken(value);
  }
  function signOut() {
    sessionStorage.removeItem(key);
    cache.removeQueries({ queryKey: [`vasp-${bank}`, "wallet"] });
    setToken(null);
  }
  return (
    <section className="role-picker">
      <h1>ユーザー {bank.toUpperCase()}</h1>
      {token === undefined ? (
        <p className="notice">セッションを確認中</p>
      ) : token ? (
        <Account bank={bank} token={token} demo={demo} signOut={signOut} />
      ) : (
        <Login bank={bank} demo={demo} onSession={signIn} />
      )}
    </section>
  );
}

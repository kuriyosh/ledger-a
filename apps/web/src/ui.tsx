import type { ReactNode } from "react";
import { ApiError } from "./api";

const labels: Record<string, string> = {
  pending: "審査中",
  approved: "承認済み",
  rejected: "却下",
  submitted: "送信済み",
  confirmed: "完了",
  executable: "実行可能",
  executed: "実行済み",
  failed: "失敗",
  cancelling: "取り下げ中",
  cancelled: "取り下げ済み",
  tr_pending: "相手 VASP が確認中",
  tr_approved: "相手 VASP が承認",
  tr_rejected: "相手 VASP が却下",
  quoted: "見積もり済み",
  expired: "期限切れ",
  reorged: "再編成で無効",
  open: "未対応",
  freeze_requested: "凍結申請中",
  frozen: "凍結済み",
  invalidated: "無効",
  closed: "閉鎖",
  suspended: "停止中",
};

const reasons: Record<string, string> = {
  SignerNotAllowed: "あなたのアドレスは現在取引できません。",
  AccountNotEligible: "相手、またはあなたのアドレスは取引できません。",
  TravelRuleRequired: "相手の事業者の確認が必要な送金です。",
  QuoteExpired: "見積もりの有効期限が切れました。",
  QUOTE_EXPIRED: "見積もりの有効期限が切れました。",
  AccountFrozen: "このトークンは現在動かせません。",
  EnforcedPause: "このトークンは現在動かせません。",
  OPERATION_IN_PROGRESS: "別の操作が進行中です。",
  UNAUTHORIZED: "ログインを確認してください。",
};

export function Status({ value }: { value: string }) {
  return (
    <span className="status" data-status={value}>
      {labels[value] ?? value}
    </span>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? (reasons[error.code] ?? error.message)
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <p role="alert" className="error-notice">
      {message}
    </p>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="detail-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function shortAddress(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function displayAmount(value?: string) {
  if (value === undefined) return "—";
  const amount = BigInt(value);
  const fraction = String(amount % 1_000_000n)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${new Intl.NumberFormat("ja-JP").format(amount / 1_000_000n)}${fraction ? `.${fraction}` : ""}`;
}

export function baseAmount(value: string) {
  if (!/^\d{1,24}(?:\.\d{1,6})?$/.test(value))
    throw new Error("金額は小数第 6 位まで入力してください。");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole + fraction.padEnd(6, "0"));
  if (amount === 0n) throw new Error("金額は 0 より大きくしてください。");
  return amount.toString();
}

export function jsonPost(value?: object, headers?: HeadersInit): RequestInit {
  const merged = new Headers(headers);
  if (value) merged.set("Content-Type", "application/json");
  return {
    method: "POST",
    headers: merged,
    body: value ? JSON.stringify(value) : undefined,
  };
}

export function formData(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget);
}

export function reason(code: string | null | undefined) {
  return code ? (reasons[code] ?? code) : null;
}

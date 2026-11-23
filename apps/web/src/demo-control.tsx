"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "./api";
import { ErrorNotice, jsonPost } from "./ui";

type Run = {
  run: number;
  startedAt: string;
  startSeq: string;
  startBlock: string;
};
type State = {
  status: "idle" | "armed" | "held" | "completed" | "expired";
  heldSeq: string | null;
  nextSeq: string | null;
};
const labels = {
  idle: "待機中",
  armed: "次の 2 件を待機",
  held: "取引を保留中",
  completed: "完了",
  expired: "期限切れ",
};

export function DemoControl() {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const run = useQuery({
    queryKey: ["demo", "run"],
    queryFn: () => api<Run>("demo", "/v1/demo/runs/current"),
    enabled: open,
    retry: false,
    refetchInterval: 2_000,
  });
  const state = useQuery({
    queryKey: ["demo", "reorder"],
    queryFn: () => api<State>("demo", "/v1/demo/state"),
    enabled: open,
    refetchInterval: 2_000,
  });
  const arm = useMutation({
    mutationFn: () => api<State>("demo", "/v1/demo/reorder-next", jsonPost()),
    onSuccess: (result) => cache.setQueryData(["demo", "reorder"], result),
  });
  return (
    <details
      className="demo-control"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>デモ操作</summary>
      {open && (
        <div className="demo-popover">
          {run.data && (
            <dl className="network-list">
              <div>
                <dt>現在のデモ回</dt>
                <dd>{run.data.run}</dd>
              </div>
              <div>
                <dt>開始時刻</dt>
                <dd>
                  {new Date(run.data.startedAt).toLocaleTimeString("ja-JP")}
                </dd>
              </div>
              <div>
                <dt>開始通番</dt>
                <dd>{run.data.startSeq}</dd>
              </div>
              <div>
                <dt>開始ブロック</dt>
                <dd>{run.data.startBlock}</dd>
              </div>
            </dl>
          )}
          {run.error instanceof ApiError && run.error.status === 404 && (
            <p>デモ回がありません。</p>
          )}
          {state.data && (
            <p aria-live="polite">
              {labels[state.data.status]}
              {state.data.heldSeq && ` · 通番 ${state.data.heldSeq}`}
              {state.data.nextSeq && `、${state.data.nextSeq}`}
            </p>
          )}
          <button
            type="button"
            disabled={
              !state.data ||
              arm.isPending ||
              ["held", "armed"].includes(state.data.status)
            }
            onClick={() => arm.mutate()}
          >
            次の 2 件の順序を入れ替える
          </button>
          <ErrorNotice error={state.error ?? arm.error} />
        </div>
      )}
    </details>
  );
}

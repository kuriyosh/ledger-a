import { expect, test } from "vitest";
import { api, waitFor } from "./support.ts";

type Person = {
  id: string;
  address: string | null;
  email: string;
  familyName: string;
  givenName: string;
};
type Operation = {
  id: string;
  status: string;
  txHash: string | null;
  gatewaySeq: string | null;
};
type Disclosure = { id: string; status: string; reason?: string };
const post = <T>(
  service: string,
  path: string,
  body?: object,
  token?: string,
) => api<T>(service, path, { body, token, method: "POST" });
const people = (service: string) =>
  api<{ customers: Person[] }>(service, "/v1/admin/customers").then(
    (result) => result.customers,
  );
const session = (service: string, email: string) =>
  post<{ token: string }>(service, "/v1/session", { email }).then(
    (result) => result.token,
  );
const transfer = (
  service: string,
  token: string,
  toAddress: string,
  symbol: string,
  amount: string,
) =>
  post<Operation>(
    service,
    "/v1/me/transfers",
    { toAddress, token: symbol, amount },
    token,
  );
const completed = (service: string, token: string, operation: Operation) =>
  waitFor(
    async () => {
      const status = await api<Operation>(
        service,
        `/v1/me/transfers/${operation.id}`,
        { token },
      );
      expect(status.status).not.toBe("failed");
      if (status.status === "confirmed" && status.txHash && status.gatewaySeq)
        return status;
    },
    "The audited transfer did not confirm",
    45_000,
  );

test.skipIf(process.env.LEDGERA_E2E !== "1")(
  "場面 6 は順序の違反と VASP 承認後の開示を確認する",
  async () => {
    const run = await api<{
      emailSuffix: string;
      startSeq: string;
      startBlock: string;
    }>("demo", "/v1/demo/runs/current");
    const [a, b] = await Promise.all([people("vasp-a"), people("vasp-b")]);
    const suzuki = a.find((row) => row.email === `suzuki${run.emailSuffix}`);
    const tan = b.find((row) => row.email === `tan${run.emailSuffix}`);
    const lee = b.find((row) => row.email === `lee${run.emailSuffix}`);
    if (!suzuki?.address || !tan?.address || !lee?.address)
      throw new Error("Seeded accounts are unavailable");
    const from = new URLSearchParams({
      fromSeq: run.startSeq,
      fromBlock: run.startBlock,
    });
    const violation = () =>
      api<{
        violations: {
          type: string;
          seqA: string;
          seqB: string;
          evidence: unknown;
        }[];
      }>("auditor", `/v1/fifo/violations?${from}`);
    const summary = () =>
      api<{ checks: Record<string, number> }>(
        "auditor",
        `/v1/fifo/summary?${from}`,
      );
    const email = `e2e-audit${run.emailSuffix}`;
    const sato = await post<Person>("vasp-a", "/v1/customers", {
      email: `e2e-audit${run.emailSuffix}`,
      familyName: "監査試験",
      givenName: "シナリオ識別",
      dateOfBirth: "1990-02-01",
      country: "JP",
      addressLine: "東京都",
    });
    await post("vasp-a", `/v1/admin/customers/${sato.id}/kyc/approve`);
    const address = await waitFor(
      async () =>
        (await people("vasp-a")).find((row) => row.id === sato.id)?.address ??
        undefined,
      "The sender needs approval",
    );
    await post("demo", "/v1/issuer/mint", {
      token: "tJPY",
      to: address,
      amount: "2000000000",
    });
    const [tokenA, tokenB] = await Promise.all([
      session("vasp-a", email),
      session("vasp-b", tan.email),
    ]);
    await post("auditor", "/v1/fifo/run");
    expect((await violation()).violations).toHaveLength(0);
    expect(
      (await post<{ status: string }>("demo", "/v1/demo/reorder-next")).status,
    ).toBe("armed");
    const first = await transfer(
      "vasp-a",
      tokenA,
      suzuki.address,
      "tJPY",
      "1000000000",
    );
    await waitFor(async () => {
      const state = await api<{ status: string }>("demo", "/v1/demo/state");
      if (state.status === "held") return state;
    }, "The first transaction was not held");
    const second = await transfer(
      "vasp-b",
      tokenB,
      lee.address,
      "tUSD",
      "10000000",
    );
    const [left, right] = await Promise.all([
      completed("vasp-a", tokenA, first),
      completed("vasp-b", tokenB, second),
    ]);
    await post("auditor", "/v1/fifo/run");
    const { violations } = await violation();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      type: "ORDER_VIOLATION",
      seqA: left.gatewaySeq,
      seqB: right.gatewaySeq,
    });
    expect(violations[0].evidence).toBeTruthy();
    expect((await summary()).checks).toMatchObject({
      C1: 0,
      C2: 0,
      C3: 0,
      C4: 1,
      C5: 0,
    });

    const trace = await api<{
      registry: { vaspId: number };
      transfers: { txHash: string }[];
    }>("auditor", `/v1/trace/${lee.address}`);
    expect(trace.registry.vaspId).toBe(2);
    expect(trace.transfers).toContainEqual(
      expect.objectContaining({ txHash: right.txHash }),
    );
    expect(JSON.stringify(trace)).not.toContain(lee.givenName);
    const reason = `デモの開示確認 ${run.emailSuffix}`;
    const disclosure = await post<Disclosure>("auditor", "/v1/disclosures", {
      address: lee.address,
      reasonCategory: "SUPERVISORY_REVIEW",
      reason,
    });
    expect(disclosure.status).toBe("pending");
    const disclosurePath = `/v1/disclosures/${disclosure.id}`;
    expect(await api("auditor", disclosurePath)).toEqual(disclosure);
    const { requests } = await api<{ requests: Disclosure[] }>(
      "vasp-b",
      "/v1/admin/disclosure-requests",
    );
    const pending = requests.find(
      (item) => item.status === "pending" && item.reason === reason,
    );
    if (!pending) throw new Error("The approval request did not reach VASP B");
    await post("vasp-b", `/v1/admin/disclosure-requests/${pending.id}/approve`);
    expect(await api("auditor", disclosurePath)).toMatchObject({
      status: "approved",
      disclosure: {
        name: {
          primaryIdentifier: lee.familyName,
          secondaryIdentifier: lee.givenName,
        },
      },
    });
  },
  180_000,
);

import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type Address,
  createPublicClient,
  type Hash,
  http,
  parseAbi,
  zeroAddress,
  zeroHash,
} from "viem";
import { beforeAll, describe, expect, test } from "vitest";
import { readDeployment } from "../../packages/config/src/deployment.ts";
import { api, waitFor } from "./support.ts";

type Run = {
  run: number;
  emailSuffix: string;
  startSeq: string;
  startBlock: string;
};
type Operation = {
  id: string;
  status: string;
  txHash: Hash | null;
  errorCode: string | null;
  gatewaySeq: string | null;
  refId?: Hash | null;
};
type Customer = {
  id: string;
  familyName: string;
  givenName: string;
  email: string;
  address: Address | null;
  kycStatus: string;
};
type Tx = {
  status: string;
  from: Address;
  failure: { errorName?: string } | null;
  events: { name: string; args: Record<string, unknown> }[];
};
const tokenAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const rpc = createPublicClient({
  transport: http(process.env.LEDGERA_E2E_RPC_URL ?? "http://127.0.0.1:8545"),
});
const exec = promisify(execFile);
async function finalizeAnvil() {
  const configured = process.env.LEDGERA_E2E_ANVIL_CONTROL_URL;
  if (!configured) {
    await exec("make", ["e2e-anvil-finalize"]);
    return;
  }
  const url = new URL(configured);
  if (url.hostname !== "127.0.0.1")
    throw new Error("Anvil test control must use loopback");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_mine",
      params: ["0x80", "0x0"],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || (await response.json()).error)
    throw new Error("Unable to finalize Anvil test blocks");
}

async function afterFinalized<T>(request: () => Promise<T>) {
  return waitFor(
    async () => {
      try {
        return await request();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("PROPOSAL_IN_PROGRESS")
        )
          throw error;
      }
    },
    "The last Safe operation is awaiting finality",
    25_000,
  );
}

const mintAmount = "2000000000000";
const buyAmount = "10000000000";
const funded = { tJPY: mintAmount, tUSD: "0" };
const swapped = { tJPY: "448000000000", tUSD: buyAmount };
const baseFor = { A: "vasp-a", B: "vasp-b" } as const;
const list = (bank: keyof typeof baseFor) =>
  api<{ customers: Customer[] }>(baseFor[bank], "/v1/admin/customers").then(
    (result) => result.customers,
  );
const wallet = (bank: keyof typeof baseFor, email: string) =>
  api<{ token: string }>(baseFor[bank], "/v1/session", {
    body: { email },
  }).then((result) => result.token);
const balances = (bank: keyof typeof baseFor, token: string) =>
  api<{ tJPY: string; tUSD: string }>(baseFor[bank], "/v1/me/balances", {
    token,
  });
const operation = (
  bank: keyof typeof baseFor,
  path: string,
  token: string,
  expected: string,
) =>
  waitFor(
    async () => {
      const row = await api<Operation>(baseFor[bank], path, { token });
      if (
        (row.status === expected || (expected === "failed" && row.errorCode)) &&
        row.txHash
      )
        return { ...row, txHash: row.txHash };
      if (row.status === "failed" && expected !== "failed")
        throw new Error(`Operation failed (${row.errorCode})`);
    },
    `The operation did not reach ${expected}`,
    45_000,
  );
const indexed = (hash: Hash, errorName?: string) =>
  waitFor(async () => {
    const row = await api<Tx | { error: unknown }>(
      "indexer",
      `/v1/txs/${hash}`,
      { status: 200 },
    ).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("returned 404"))
        return undefined;
      throw error;
    });
    if (
      row &&
      "events" in row &&
      (!errorName || row.failure?.errorName === errorName)
    )
      return row;
  }, "Transaction was not indexed with the expected result");
const post = <T>(
  service: string,
  path: string,
  body?: object,
  token?: string,
) => api<T>(service, path, { body, token, method: "POST" });
const transfer = (
  bank: keyof typeof baseFor,
  token: string,
  customer: Customer | Address,
  amount: string,
  symbol: string,
  skipChecks = false,
) =>
  post<Operation>(
    baseFor[bank],
    "/v1/me/transfers",
    {
      toAddress: typeof customer === "string" ? customer : customer.address,
      token: symbol,
      amount,
      ...(typeof customer !== "string" && {
        beneficiaryName: {
          primaryIdentifier: customer.familyName,
          secondaryIdentifier: customer.givenName,
        },
      }),
      ...(skipChecks && { demo: { skipChecks } }),
    },
    token,
  );

describe.skipIf(process.env.LEDGERA_E2E !== "1")(
  "ledgerA デモ場面 1〜5",
  () => {
    let run: Run;
    let deployment: Awaited<ReturnType<typeof readDeployment>>;
    let a: string;
    let b: string;
    let sato: Customer & { address: Address };
    let lim: Customer & { address: Address };
    let lee: Customer & { address: Address };

    beforeAll(async () => {
      run = await api<Run>("demo", "/v1/demo/runs/current");
      const mode = process.env.APP_MODE === "anvil" ? "anvil" : "devnet";
      deployment = await readDeployment(
        process.env.LEDGERA_E2E_DEPLOYMENTS ?? `deployments/${mode}.json`,
      );
      expect(await rpc.getChainId()).toBe(deployment.chainId);
      const users = await list("B");
      const recipient = users.find(
        (item) => item.email === `lim${run.emailSuffix}`,
      );
      const other = users.find(
        (item) => item.email === `lee${run.emailSuffix}`,
      );
      if (!recipient?.address || !other?.address)
        throw new Error("The seeded customers are not active");
      lim = { ...recipient, address: recipient.address };
      lee = { ...other, address: other.address };
      b = await wallet("B", lim.email);
    }, 45_000);

    async function createWallet(
      bank: keyof typeof baseFor,
      label: string,
      symbol = "tJPY",
      amount = mintAmount,
    ) {
      const service = baseFor[bank];
      const created = await post<Customer>(service, "/v1/customers", {
        familyName: "監査試験",
        givenName: "シナリオ識別",
        email: label + run.emailSuffix,
        dateOfBirth: "1990-01-20",
        country: bank === "A" ? "JP" : "SG",
        addressLine: bank === "A" ? "東京都" : "シンガポール",
      });
      expect(created.kycStatus).toBe("pending");
      await post(service, `/v1/admin/customers/${created.id}/kyc/approve`);
      const customer = await waitFor(async () => {
        const row = (await list(bank)).find((item) => item.id === created.id);
        if (row?.address && row.kycStatus === "approved")
          return { ...row, address: row.address };
      }, "Customer not approved");
      const session = await wallet(bank, customer.email);
      const { txHash } = await post<{ txHash: Hash }>(
        "demo",
        "/v1/issuer/mint",
        { token: symbol, to: customer.address, amount },
      );
      expect((await indexed(txHash)).status).toBe("success");
      return { customer, session };
    }

    test("場面 1 は承認と発行の後に残高を表示する", async () => {
      const opened = await createWallet("A", "e2e-sato");
      sato = opened.customer;
      a = opened.session;
      expect(await balances("A", a)).toEqual(funded);
      expect(await rpc.getBalance({ address: sato.address })).toBe(0n);
      const registry = await api<{
        account: { vaspId: number; kind: number; status: number };
        history: unknown[];
      }>("indexer", `/v1/registry/accounts/${sato.address}`);
      expect(registry.account).toMatchObject({ vaspId: 1, kind: 1, status: 1 });
      expect(JSON.stringify(registry)).not.toContain(sato.familyName);
      expect(JSON.stringify(registry)).not.toContain(sato.givenName);
    }, 75_000);

    test("場面 2 は 1 件で交換し、期限切れで残高が変わらない", async () => {
      const quote = (amount: string, session = a) =>
        post<{ quoteId: string; expiresAt: string; rate: string }>(
          "vasp-a",
          "/v1/me/swaps/quote",
          {
            sellToken: "tJPY",
            buyToken: "tUSD",
            buyAmount: amount,
          },
          session,
        );
      const initial = await quote(buyAmount);
      expect(initial.rate).toBe("155.20");
      const first = await post<Operation>(
        "vasp-a",
        "/v1/me/swaps",
        { quoteId: initial.quoteId },
        a,
      );
      const settled = await operation(
        "A",
        `/v1/me/swaps/${first.id}`,
        a,
        "confirmed",
      );
      const tx = await indexed(settled.txHash);
      expect(
        tx.events.filter((event) => event.name === "Transfer"),
      ).toHaveLength(2);
      expect(await balances("A", a)).toEqual(swapped);
      expect(await rpc.getBalance({ address: sato.address })).toBe(0n);
      const expiredWallet = await createWallet("A", "e2e-expiry");
      const next = await quote("1000000000", expiredWallet.session);
      await setTimeout(
        Math.max(0, Date.parse(next.expiresAt) - Date.now() + 1100),
      );
      const expiry = BigInt(Math.floor(Date.parse(next.expiresAt) / 1_000));
      await waitFor(async () => {
        const block = await rpc.getBlock({ blockTag: "latest" });
        if (block.timestamp > expiry) return block;
      }, "The quote is still valid at the latest L2 timestamp");
      const expired = await post<Operation>(
        "vasp-a",
        "/v1/me/swaps",
        { quoteId: next.quoteId, demo: { allowExpired: true } },
        expiredWallet.session,
      );
      const failed = await operation(
        "A",
        `/v1/me/swaps/${expired.id}`,
        expiredWallet.session,
        "failed",
      );
      expect((await indexed(failed.txHash, "QuoteExpired")).status).toBe(
        "failed",
      );
      expect(await balances("A", expiredWallet.session)).toEqual(funded);
    }, 100_000);

    test("場面 3 は VASP B の承認から入金まで参照 ID が一致する", async () => {
      const pending = await transfer("A", a, lim, buyAmount, "tUSD");
      expect(pending.status).toBe("created");
      const refId = await waitFor(async () => {
        const row = await api<Operation>(
          "vasp-a",
          `/v1/me/transfers/${pending.id}`,
          { token: a },
        );
        if (row.status === "tr_pending" && row.refId) return row.refId;
      }, "Transfer is waiting for the recipient VASP");
      const record = await waitFor(async () => {
        const rows = await api<{
          messages: { refId: Hash; nameMatch: boolean; status: string }[];
        }>("vasp-b", "/v1/admin/travel-rule?direction=in");
        return rows.messages.find(
          (item) => item.status === "pending" && item.refId === refId,
        );
      }, "No Travel Rule approval request");
      expect(record.nameMatch).toBe(true);
      await post("vasp-b", `/v1/admin/travel-rule/${record.refId}/approve`);
      const settled = await operation(
        "A",
        `/v1/me/transfers/${pending.id}`,
        a,
        "confirmed",
      );
      const tx = await indexed(settled.txHash);
      expect(tx.events).toContainEqual(
        expect.objectContaining({
          name: "TravelRuleAttestationConsumed",
          args: expect.objectContaining({ refId: record.refId }),
        }),
      );
      expect(JSON.stringify(tx)).not.toContain(sato.familyName);
      expect(JSON.stringify(tx)).not.toContain(lim.givenName);
      expect((await balances("B", b)).tUSD).toBe(buyAmount);
    }, 80_000);

    test("場面 4 では対象外の宛先と確認のない送金を L2 が拒否する", async () => {
      const absent = "0x000000000000000000000000000000000000beEf" as Address;
      for (const [name, to, errorName] of [
        ["rule-unregistered", absent, "AccountNotEligible"],
        ["rule-travel", lim, "TravelRuleRequired"],
      ] as const) {
        const token = await wallet("A", name + run.emailSuffix);
        const before = await balances("A", token);
        expect(before).toEqual({ tJPY: "1000000000", tUSD: "0" });
        const attempted = await transfer(
          "A",
          token,
          to,
          "1000000000",
          "tJPY",
          true,
        );
        const failed = await operation(
          "A",
          `/v1/me/transfers/${attempted.id}`,
          token,
          "failed",
        );
        expect((await indexed(failed.txHash, errorName)).status).toBe("failed");
        expect(await balances("A", token)).toEqual(before);
      }
    }, 105_000);

    test("場面 5 は 2 名で遮断し、その後の送金と交換が失敗する", async () => {
      const alert = await waitFor(async () => {
        const result = await api<{
          alerts: {
            id: string;
            customerId: string;
            rule: string;
            status: string;
          }[];
        }>("vasp-b", "/v1/admin/alerts");
        return result.alerts.find(
          (row) => row.customerId === lim.id && row.rule === "LARGE_AMOUNT",
        );
      }, "No AML alert for recipient");
      expect(alert.status).toBe("open");
      if (deployment.environment === "anvil") await finalizeAnvil();
      await afterFinalized(() =>
        post("vasp-b", `/v1/admin/alerts/${alert.id}/request-freeze`),
      );
      const result = await api<{
        proposals: {
          id: string;
          params: { account?: Address };
          status: string;
        }[];
      }>("consortium", "/v1/proposals");
      const proposal = result.proposals.find(
        (item) =>
          item.status === "open" &&
          item.params.account?.toLowerCase() === lim.address.toLowerCase(),
      );
      if (!proposal) throw new Error("No freeze proposal");
      const path = `/v1/proposals/${proposal.id}`;
      await post("consortium", `${path}/approve`, { memberId: 1 });
      const early = await api<{ error: { code: string } }>(
        "consortium",
        `${path}/execute`,
        { body: { memberId: 1 }, status: 409 },
      );
      expect(early.error.code).toBe("NOT_EXECUTABLE");
      await post("consortium", `${path}/approve`, { memberId: 2 });
      await post("consortium", `${path}/execute`, { memberId: 2 });
      const blocked = await waitFor(async () => {
        const entry = await api<{
          account: { status: number };
          history: { actor: Address }[];
        }>("indexer", `/v1/registry/accounts/${lim.address}`);
        if (entry.account.status === 3) return entry;
      }, "The freeze did not reach the Indexer");
      expect(blocked.history[0].actor.toLowerCase()).toBe(
        deployment.contracts.consortiumSafe.toLowerCase(),
      );
      const sent = await transfer("B", b, lee, "100000000", "tUSD");
      const failed = await operation(
        "B",
        `/v1/me/transfers/${sent.id}`,
        b,
        "failed",
      );
      expect((await indexed(failed.txHash, "SignerNotAllowed")).status).toBe(
        "failed",
      );
      const allowance = () =>
        rpc.readContract({
          address: deployment.contracts.tUSD,
          abi: tokenAbi,
          functionName: "allowance",
          args: [lim.address, deployment.contracts.atomicSwap],
        });
      expect(await allowance()).toBe(0n);
      expect((await balances("B", b)).tUSD).toBe(buyAmount);
      if (deployment.environment !== "anvil") return;
      await finalizeAnvil();
      const secondary = await createWallet(
        "B",
        "e2e-blocked-swap",
        "tUSD",
        buyAmount,
      );
      const quote = await post<{ quoteId: string }>(
        "vasp-b",
        "/v1/me/swaps/quote",
        {
          sellToken: "tUSD",
          buyToken: "tJPY",
          buyAmount: "1000000",
        },
        secondary.session,
      );
      const blockedSwap = await afterFinalized(() =>
        post<{ id: string }>("consortium", "/v1/proposals", {
          type: "BLOCK_ACCOUNT",
          params: { account: secondary.customer.address, reasonId: zeroHash },
          reason: "デモの凍結検証",
          requestedBy: { memberId: 1 },
        }),
      );
      const secondPath = `/v1/proposals/${blockedSwap.id}`;
      await post("consortium", `${secondPath}/approve`, { memberId: 1 });
      await post("consortium", `${secondPath}/approve`, { memberId: 2 });
      await post("consortium", `${secondPath}/execute`, { memberId: 2 });
      await waitFor(async () => {
        const view = await api<{ account: { status: number } }>(
          "indexer",
          `/v1/registry/accounts/${secondary.customer.address}`,
        );
        if (view.account.status === 3) return view;
      }, "The swap test account was not frozen");
      const swap = await post<Operation>(
        "vasp-b",
        "/v1/me/swaps",
        { quoteId: quote.quoteId },
        secondary.session,
      );
      const stopped = await operation(
        "B",
        `/v1/me/swaps/${swap.id}`,
        secondary.session,
        "failed",
      );
      expect((await indexed(stopped.txHash, "SignerNotAllowed")).status).toBe(
        "failed",
      );
      expect(
        await rpc.readContract({
          address: deployment.contracts.tUSD,
          abi: tokenAbi,
          functionName: "allowance",
          args: [secondary.customer.address, deployment.contracts.atomicSwap],
        }),
      ).toBe(0n);
      expect(await balances("B", secondary.session)).toEqual({
        tUSD: buyAmount,
        tJPY: "0",
      });
      expect(await rpc.getBalance({ address: lim.address })).toBe(0n);
      expect(lim.address).not.toBe(zeroAddress);
    }, 115_000);
  },
);

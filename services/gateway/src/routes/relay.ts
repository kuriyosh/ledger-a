import { ServiceError } from "@ledgera/shared/errors";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Address, Hex, LocalAccount } from "viem";
import type { ForwardNotifications } from "../chain/forwarder.ts";
import type { relayChain } from "../chain/relay.ts";
import { type GatewayStore, receiptJson } from "../db/store.ts";
import { AdmissionError, type createAdmission } from "../domain/admission.ts";
import {
  type createRelayAuth,
  prepareForwardCall,
  relayRequestSchema,
} from "../domain/relay.ts";
import { waitForForwarding } from "./gateway.ts";

const statusByCode: Record<string, ContentfulStatusCode> = {
  UNAUTHORIZED: 401,
  TARGET_NOT_ALLOWED: 403,
  SIGNER_NOT_OF_VASP: 403,
  INVALID_REQUEST: 422,
  SIMULATION_REVERTED: 422,
  RATE_LIMITED: 429,
  FORWARD_REJECTED: 502,
  SEQUENCER_UNAVAILABLE: 503,
};

type Options = {
  authorize: ReturnType<typeof createRelayAuth>;
  relayers: ReadonlyMap<number, LocalAccount>;
  chain: ReturnType<typeof relayChain>;
  stores: { receipts: GatewayStore; notifications: ForwardNotifications };
  admission: ReturnType<typeof createAdmission>;
  signal: AbortSignal;
  policy: {
    chainId: number;
    forwarder: Address;
    tokenAddresses: readonly Address[];
    swap: Address;
    maxFee: bigint;
    fixedPriorityFee: bigint;
    fallbackGas: bigint;
  };
};

export function relayRoutes({
  authorize,
  relayers,
  chain,
  stores,
  admission,
  signal,
  policy,
}: Options) {
  const app = new Hono();
  app.post("/relay/v1/forward", async (context) => {
    try {
      const vaspId = authorize(context.req.header("Authorization"));
      const relayer = relayers.get(vaspId);
      if (!relayer)
        throw new AdmissionError(
          "UNAUTHORIZED",
          "VASP relayer is not configured",
        );
      if (signal.aborted)
        throw new AdmissionError(
          "SEQUENCER_UNAVAILABLE",
          "gateway is stopping",
        );

      const parsed = relayRequestSchema.safeParse(
        await context.req.json().catch(() => undefined),
      );
      if (!parsed.success)
        throw new AdmissionError("INVALID_REQUEST", "invalid relay request");

      const { data, operations } = await prepareForwardCall(
        policy,
        chain,
        vaspId,
        parsed.data.requests,
      );
      const evaluation = await chain.simulate(relayer.address, data);
      if (evaluation.reverted && !parsed.data.submitOnRevert) {
        throw new AdmissionError(
          "SIMULATION_REVERTED",
          "forwarder simulation reverted",
          evaluation,
        );
      }
      const gas = evaluation.reverted
        ? policy.fallbackGas
        : (13n * evaluation.estimatedGas + 9n) / 10n;
      const simulation = evaluation.reverted ? evaluation : { reverted: false };
      const receipt = await admission.acceptRelay({
        sender: relayer.address,
        vaspId,
        operations,
        sign(nonce): Promise<Hex> {
          if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new AdmissionError(
              "INVALID_REQUEST",
              "relayer nonce is outside the supported range",
            );
          }
          return relayer.signTransaction({
            type: "eip1559",
            chainId: policy.chainId,
            nonce: Number(nonce),
            to: policy.forwarder,
            data,
            value: 0n,
            gas,
            maxFeePerGas: policy.maxFee,
            maxPriorityFeePerGas: policy.fixedPriorityFee,
          });
        },
      });
      await waitForForwarding(
        stores.receipts,
        receipt,
        stores.notifications,
        AbortSignal.any([signal, context.req.raw.signal]),
      );
      return context.json({
        txHash: receipt.txHash,
        receipt: receiptJson(receipt),
        simulation,
      });
    } catch (error) {
      if (error instanceof AdmissionError) {
        throw new ServiceError(
          error.code,
          error.message,
          statusByCode[error.code] ?? 422,
          error.details,
        );
      }
      throw error;
    }
  });
  return app;
}

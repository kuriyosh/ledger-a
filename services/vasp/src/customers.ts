import { setTimeout } from "node:timers/promises";
import { ServiceError } from "@ledgera/shared/errors";
import { logService } from "@ledgera/shared/server";
import type { registryChain, registryGateway } from "./chain.ts";
import type {
  RegistryAction,
  RegistryRequest,
  RegistryResult,
  VaspStore,
} from "./db/store.ts";

export function customerService(
  store: Pick<
    VaspStore,
    "customer" | "prepareRegistry" | "settleRegistry" | "nextRegistryRequest"
  >,
  chain: Pick<ReturnType<typeof registryChain>, "build" | "receipt" | "wait">,
  gateway: ReturnType<typeof registryGateway>,
  validityDays: number,
) {
  let tail = Promise.resolve();

  function serialize<T>(action: () => Promise<T>) {
    const next = tail.then(action);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async function processRequest(pending: RegistryRequest) {
    let outcome: RegistryResult | undefined;
    try {
      outcome = await chain.receipt(pending.txHash);
      if (!outcome && (await gateway.submit(pending)) === "accepted") {
        outcome = await chain.wait(pending.txHash);
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        "REGISTRY_PENDING",
        "Registry transaction is pending",
        503,
        { txHash: pending.txHash },
      );
    }

    const customer = await store.settleRegistry(pending, outcome);
    if (!outcome?.success) {
      throw new ServiceError(
        "REGISTRY_REJECTED",
        "Registry transaction failed",
        422,
        { txHash: pending.txHash, kycStatus: customer.kycStatus },
      );
    }
    return { customer, txHash: pending.txHash };
  }

  function mutate(id: string, action: RegistryAction) {
    return serialize(async () => {
      const pending = await store.prepareRegistry(
        id,
        action,
        validityDays,
        (address, validUntil) => chain.build(action, address, validUntil),
      );
      return pending
        ? processRequest(pending)
        : { customer: await store.customer(id), txHash: null };
    });
  }

  function recover() {
    return serialize(async () => {
      const pending = await store.nextRegistryRequest();
      if (pending) await processRequest(pending);
    });
  }

  async function poll(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        await recover();
      } catch (error) {
        if (!signal.aborted)
          logService(
            "vasp",
            "error",
            "Registry request did not advance",
            null,
            {
              code:
                error instanceof ServiceError ? error.code : "INTERNAL_ERROR",
            },
          );
      }
      await setTimeout(2_000, undefined, { signal }).catch(() => {});
    }
  }

  return { mutate, recover, poll };
}

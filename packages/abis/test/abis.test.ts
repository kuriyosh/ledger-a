import { expect, test } from "vitest";
import {
  consortiumSafeAbi,
  kycRegistryAbi,
  ledgerTokenAbi,
} from "../src/index.ts";

test("exports the Forge ABI for the Registry, token, and Safe", () => {
  expect(kycRegistryAbi).toContainEqual(
    expect.objectContaining({ type: "function", name: "isActive" }),
  );
  expect(ledgerTokenAbi).toContainEqual(
    expect.objectContaining({
      type: "function",
      name: "transferWithTravelRule",
    }),
  );
  expect(consortiumSafeAbi).toContainEqual(
    expect.objectContaining({ type: "function", name: "getTransactionHash" }),
  );
});

import type { Address, Hex } from "viem";

type NonceBlock = {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  transactions: readonly { from: Address; nonce: number; hash: Hex }[];
};

type NonceHistory = {
  finalized(): Promise<NonceBlock>;
  body(hash: Hex): Promise<NonceBlock>;
  hashAt(height: bigint): Promise<Hex>;
  countAt(hash: Hex): Promise<number>;
};

export async function finalizedReplacement(
  history: NonceHistory,
  request: { sender: Address; nonce: number; txHash: Hex; firstBlock: bigint },
) {
  const finalized = await history.finalized();
  if (
    request.firstBlock > finalized.number ||
    (await history.countAt(finalized.hash)) <= request.nonce
  )
    return false;

  const sender = request.sender.toLowerCase();
  let block = finalized;
  while (block.number >= request.firstBlock) {
    const consumed = block.transactions.find(
      (transaction) =>
        transaction.from.toLowerCase() === sender &&
        transaction.nonce === request.nonce,
    );
    if (consumed) {
      return (
        consumed.hash !== request.txHash &&
        (await history.hashAt(finalized.number)) === finalized.hash
      );
    }
    if (block.number === request.firstBlock) break;
    const parent = await history.body(block.parentHash);
    if (parent.hash !== block.parentHash || parent.number + 1n !== block.number)
      return false;
    block = parent;
  }
  return false;
}

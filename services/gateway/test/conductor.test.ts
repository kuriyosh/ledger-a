import { expect, test, vi } from "vitest";
import { conductorCluster } from "../src/chain/conductor.ts";

test("selects one healthy Raft leader and stops routing without a majority", async () => {
  const peers = [1, 2, 3].map((id) => ({
    id: String(id),
    rpc: `http://execution-${id}`,
    conductor: `http://conductor-${id}`,
  }));
  let time = 0;
  let leader = 1;
  let secondLeader = false;
  let reachable = 3;
  const send = vi.fn(async (url: string | URL | Request) => {
    const id = Number(String(url).at(-1));
    if (id > reachable) throw new Error("peer unavailable");
    return Response.json([
      { id: 2, result: true },
      { id: 0, result: id === leader || (secondLeader && id === 2) },
      { id: 1, result: true },
    ]);
  });
  const check = conductorCluster(peers, send, () => time);
  expect((await check()).selected?.id).toBe("1");
  leader = 2;
  expect((await check()).selected?.id).toBe("1");
  expect(send).toHaveBeenCalledTimes(3);
  time += 1_000;
  expect((await check()).selected?.id).toBe("2");
  leader = 1;
  secondLeader = true;
  time += 1_000;
  expect((await check()).selected).toBeUndefined();
  reachable = 1;
  time += 1_000;
  expect((await check()).selected).toBeUndefined();
});

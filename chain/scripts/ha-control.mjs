import { lookup } from "node:dns/promises";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const ids = [1, 2, 3];
async function rpc(url, method, params = []) {
  const reply = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(1_000),
  });
  if (!reply.ok) throw new Error(`${method} returned ${reply.status}`);
  const body = await reply.json();
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result;
}

function executionIpc(id, method, params = []) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(`/reth/${id}/reth.ipc`);
    const lines = createInterface({ input: socket });
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(1_200, () => fail(new Error("Execution IPC timed out")));
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
        })}\n`,
      ),
    );
    socket.once("error", fail);
    socket.once("end", () => fail(new Error("Execution IPC closed")));
    lines.once("line", (line) => {
      socket.end();
      try {
        const response = JSON.parse(line);
        if (response.error) throw new Error(response.error.message);
        resolve(response.result);
      } catch (error) {
        fail(error);
      }
    });
  });
}

async function connectExecutions() {
  const endpoints = await Promise.all(
    ids.map(async (id) => {
      const info = await executionIpc(id, "admin_nodeInfo");
      const enode = /^enode:\/\/([a-f0-9]{128})@/i.exec(info.enode);
      if (!enode) throw new Error("The execution peer ID is unavailable");
      const { address } = await lookup(`op-reth-${id}`, { family: 4 });
      return { id, enode: `enode://${enode[1]}@${address}:30303` };
    }),
  );
  await Promise.all(
    endpoints.flatMap((from) =>
      endpoints
        .filter((to) => from.id !== to.id)
        .map((to) => executionIpc(from.id, "admin_addPeer", [to.enode])),
    ),
  );
  return true;
}

const control = (id, method, params) =>
  rpc(`http://op-conductor-${id}:8547`, `conductor_${method}`, params);
const activeNode = (id) =>
  rpc(`http://op-node-${id}:8547`, "admin_sequencerActive");

async function getLeader() {
  const flags = await Promise.all(
    ids.map((id) => control(id, "leader").catch(() => false)),
  );
  const leaders = ids.filter((_, index) => flags[index] === true);
  return leaders.length === 1 ? leaders[0] : undefined;
}

async function waitFor(action, message, ms = 60_000) {
  const end = Date.now() + ms;
  let lastError;
  do {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  } while (Date.now() < end);
  throw new Error(message, { cause: lastError });
}

async function joinCluster() {
  await waitFor(async () => {
    const leader = await getLeader();
    if (!leader) return;
    await Promise.all(ids.map((id) => control(id, "active")));
    for (const id of ids) {
      const label = `sequencer-${id}`;
      const address = `op-conductor-${id}:50050`;
      const current = await control(leader, "clusterMembership");
      const existing = current.servers.find((server) => server.id === label);
      if (existing && existing.addr !== address) {
        throw new Error(`Unexpected Raft address for ${label}`);
      }
      if (!existing) {
        await control(leader, "addServerAsVoter", [
          label,
          address,
          current.version,
        ]);
      }
    }
    return true;
  }, "Unable to initialize Raft membership");
}

async function bootstrapSequencing() {
  const running = await Promise.all(ids.map(activeNode));
  if (running.filter(Boolean).length > 1) {
    throw new Error("More than one sequencer is active");
  }
  if (!running.some(Boolean)) {
    await Promise.all(
      ids.map(async (id) => {
        if (await control(id, "active")) await control(id, "pause");
      }),
    );
    // Raft needs the first unsafe payload before Conductor can start a sequencer.
    const seed = await waitFor(async () => {
      const leader = await getLeader();
      if (!leader) return;
      const url = `http://op-node-${leader}:8547`;
      const status = await rpc(url, "optimism_syncStatus");
      if (!(await activeNode(leader))) {
        await rpc(url, "admin_startSequencer", [status.unsafe_l2.hash]);
      }
      return { leader, url, height: BigInt(status.unsafe_l2.number) };
    }, "Unable to start the Raft leader");
    await waitFor(async () => {
      if ((await getLeader()) !== seed.leader) return false;
      const status = await rpc(seed.url, "optimism_syncStatus");
      return BigInt(status.unsafe_l2.number) > seed.height;
    }, "The first unsafe payload did not advance");
  }
  await Promise.all(
    ids.map(async (id) => {
      if (!(await control(id, "active"))) await control(id, "resume");
    }),
  );
}

async function runningLeader() {
  const leader = await getLeader();
  if (!leader) return;
  if (!(await activeNode(leader))) return;
  if (!(await control(leader, "sequencerHealthy"))) return;
  return leader;
}

switch (process.argv[2]) {
  case "init":
    await waitFor(connectExecutions, "The execution nodes did not open IPC");
    await joinCluster();
    await bootstrapSequencing();
    console.log(await waitFor(runningLeader, "No active healthy sequencer"));
    break;
  case "leader":
    console.log(
      await waitFor(runningLeader, "No active healthy sequencer", 10_000),
    );
    break;
  case "restore": {
    const id = Number(process.argv[3]);
    if (!ids.includes(id)) throw new Error("Expected a sequencer number");
    await waitFor(
      connectExecutions,
      "The restored execution node did not open IPC",
    );
    await waitFor(async () => {
      if (!(await control(id, "active"))) await control(id, "resume");
      const leader = await runningLeader();
      if (!leader) return false;
      const local = await rpc(`http://op-reth-${id}:8545`, "eth_blockNumber");
      const head = await rpc(
        `http://op-reth-${leader}:8545`,
        "eth_blockNumber",
      );
      return (
        BigInt(local) + 2n >= BigInt(head) &&
        leader !== id &&
        !(await activeNode(id))
      );
    }, "The restored sequencer did not catch up");
    break;
  }
  default:
    throw new Error("Expected init, leader, or restore");
}

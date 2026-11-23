type Peer = { id: string; rpc: string; conductor: string };
export type SequencerNode = {
  id: string;
  reachable: boolean;
  leader: boolean;
  active: boolean;
  healthy: boolean;
};
const methods = [
  "conductor_leader",
  "conductor_active",
  "conductor_sequencerHealthy",
] as const;

export function conductorCluster(peers: Peer[], send = fetch, now = Date.now) {
  let pending: ReturnType<typeof probe> | undefined;
  let snapshot: Awaited<ReturnType<typeof probe>> | undefined;

  async function check(peer: Peer): Promise<SequencerNode> {
    const report = {
      id: peer.id,
      reachable: false,
      leader: false,
      active: false,
      healthy: false,
    };
    try {
      const response = await send(peer.conductor, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(900),
        body: JSON.stringify(
          methods.map((method, id) => ({ jsonrpc: "2.0", method, id })),
        ),
      });
      if (!response.ok) return report;
      const data: unknown = await response.json();
      if (!Array.isArray(data)) return report;
      const flags = methods.map((_, id) => {
        const entry = data.find((value) => value?.id === id);
        return typeof entry?.result === "boolean" ? entry.result : undefined;
      });
      if (flags.some((flag) => flag === undefined)) return report;
      return {
        ...report,
        reachable: true,
        leader: flags[0] === true,
        active: flags[1] === true,
        healthy: flags[2] === true,
      };
    } catch {
      return report;
    }
  }

  async function probe() {
    const nodes = await Promise.all(peers.map(check));
    const leaders = nodes.filter((node) => node.leader);
    const leader = leaders.length === 1 ? leaders[0] : undefined;
    const majority =
      nodes.filter((node) => node.reachable).length > peers.length / 2;
    const selected =
      majority && leader?.active && leader.healthy
        ? peers.find((peer) => peer.id === leader.id)
        : undefined;
    return { selected, nodes, expiresAt: now() + 750 };
  }

  return async () => {
    if (snapshot && now() < snapshot.expiresAt) return snapshot;
    pending ??= probe()
      .then((result) => {
        snapshot = result;
        return result;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

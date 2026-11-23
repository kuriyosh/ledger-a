import { parseArgs } from "node:util";
import { z } from "zod";
import { uint64 } from "./sources.ts";

try {
  const options = parseArgs({
    options: {
      from: { type: "string", default: "1" },
      json: { type: "boolean", default: false },
    },
  }).values;
  const from = uint64.refine((value) => value > 0n).parse(options.from);
  const url = z
    .url({ protocol: /^https?$/ })
    .parse(process.env.AUDITOR_URL ?? "http://127.0.0.1:8650");
  const summaryResponse = await fetch(new URL("/v1/fifo/run", url), {
    method: "POST",
    signal: AbortSignal.timeout(300_000),
  });
  if (!summaryResponse.ok)
    throw new Error(`Audit request returned HTTP ${summaryResponse.status}`);
  const query = `?fromSeq=${from}`;
  const paths = ["summary", "violations", "exclusions"];
  const results = await Promise.all(
    paths.map(async (path) => {
      const response = await fetch(new URL(`/v1/fifo/${path}${query}`, url), {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(`Audit API returned HTTP ${response.status}`);
      return response.json();
    }),
  );
  const [summary, { violations }, { exclusions }] = results;
  if (options.json)
    console.log(JSON.stringify({ summary, violations, exclusions }, null, 2));
  else {
    console.log(
      `検査済み通番 ${summary.lastSeq}、ブロック ${summary.lastBlock ?? "-"}`,
    );
    console.log(`違反 ${violations.length} 件、除外 ${exclusions.length} 件`);
    for (const violation of violations) {
      console.log(
        `${violation.type} ${violation.seqA ?? violation.txHash ?? ""}`,
      );
    }
  }
  process.exitCode = violations.length ? 1 : 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Audit failed");
  process.exitCode = 2;
}

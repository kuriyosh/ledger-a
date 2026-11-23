import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const directory = new URL("../src/db/migrations/", import.meta.url);
const files = () =>
  readdirSync(directory).filter((name) => name.endsWith(".sql"));
const before = new Set(files());
const generated = spawnSync(
  "drizzle-kit",
  ["generate", ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);
if (generated.status !== 0) process.exit(generated.status ?? 1);

// The same DDL runs in vasp_a and vasp_b through each instance's search_path.
for (const name of files()) {
  if (before.has(name)) continue;
  const file = new URL(name, directory);
  const content = readFileSync(file, "utf8").replaceAll('"public".', "");
  writeFileSync(file, content);
}

import { notFound } from "next/navigation";
import { Auditor } from "../../../src/auditor";
import { EnforcementDemo } from "../../../src/enforcement-demo";
import { Consortium, VaspAdmin } from "../../../src/management";
import { roles } from "../../../src/roles";
import { Wallet } from "../../../src/wallet";

export default async function RolePage({
  params,
}: {
  params: Promise<{ role: string; group?: string[] }>;
}) {
  const { role, group } = await params;
  const path = `/${[role, ...(group ?? [])].join("/")}`;
  const selected = roles.find((item) => item.path === path);
  if (!selected) notFound();
  if (role === "attacker") {
    return (
      <EnforcementDemo
        enabled={
          process.env.DEMO_MODE === "true" &&
          process.env.LEDGERA_APP_MODE !== "anvil"
        }
      />
    );
  }

  if (role === "auditor")
    return <Auditor demo={process.env.DEMO_MODE === "true"} />;
  if (role === "user")
    return (
      <Wallet
        key={path}
        bank={path === "/user/a" ? "a" : "b"}
        demo={process.env.DEMO_MODE === "true"}
      />
    );
  if (role === "vasp")
    return (
      <VaspAdmin
        key={path}
        bank={path === "/vasp/a" ? "a" : "b"}
        demo={process.env.DEMO_MODE === "true"}
      />
    );
  if (role === "consortium") return <Consortium />;
  return (
    <section className="role-picker">
      <p className="section-label">{selected.section}</p>
      <h1>{selected.label}</h1>
      <p className="notice" role="status">
        {selected.description}の画面は準備中です。
      </p>
    </section>
  );
}

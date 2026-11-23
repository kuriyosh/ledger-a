import { notFound } from "next/navigation";
import { roles } from "../../../src/roles";

export default async function RolePage({
  params,
}: {
  params: Promise<{ role: string; group?: string[] }>;
}) {
  const { role, group } = await params;
  const path = `/${[role, ...(group ?? [])].join("/")}`;
  const selected = roles.find((item) => item.path === path);
  if (!selected) notFound();
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

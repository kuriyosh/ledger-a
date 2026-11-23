import Link from "next/link";
import { roles } from "../src/roles";

export default function Home() {
  return (
    <section className="role-picker">
      <h1>役割を選択</h1>
      <div className="role-grid">
        {roles.map((role) => (
          <Link key={role.path} className="role-card" href={role.path}>
            <strong>{role.label}</strong>
            <span>{role.description}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Dashboard } from "../src/dashboard";
import "./globals.css";

export const metadata: Metadata = {
  title: "ledgerA",
  description: "決済ネットワークのデモ画面",
};

export const dynamic = "force-dynamic";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <a className="skip-link" href="#role-workspace">
          役割の画面へ
        </a>
        <Dashboard
          mode={process.env.LEDGERA_APP_MODE ?? "devnet"}
          demo={process.env.DEMO_MODE === "true"}
          batcher={process.env.BATCHER_ADDRESS}
        >
          {children}
        </Dashboard>
      </body>
    </html>
  );
}

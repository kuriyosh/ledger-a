export const roles = [
  {
    path: "/user/a",
    label: "ユーザー A",
    description: "VASP A のウォレット",
    section: "ウォレット",
  },
  {
    path: "/user/b",
    label: "ユーザー B",
    description: "VASP B のウォレット",
    section: "ウォレット",
  },
  {
    path: "/vasp/a",
    label: "VASP A",
    description: "顧客と送金の管理",
    section: "事業者",
  },
  {
    path: "/vasp/b",
    label: "VASP B",
    description: "顧客と送金の管理",
    section: "事業者",
  },
  {
    path: "/consortium",
    label: "コンソーシアム",
    description: "申請、承認、実行",
    section: "ネットワーク運営",
  },
  {
    path: "/auditor",
    label: "監査者",
    description: "受付順とアドレスの確認",
    section: "監査",
  },
  {
    path: "/attacker",
    label: "外部者",
    description: "未登録アドレスの状態",
    section: "ネットワーク",
  },
] as const;

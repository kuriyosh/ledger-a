# ledgerA

OP Stack を使った金融向け Ethereum L2 の DevNet。KYC 済みの顧客アドレスと、許可された運営アカウントが取引できる。
デモでは、トークンの送金と交換、KYC による取引制限、受付順の監査、Sequencer の切替を確認できる。

## セットアップ

mise 2026.7.10 以降、Docker Compose 2.24.4 以降、Docker Buildx、Git を用意する。リポジトリのルートで実行する。Windows では WSL2 を使う。手順は [開発と運用](docs/10-dev-ops.md#11-windowswsl2) を参照する。

```sh
mise trust
mise install
mise run setup
```

開発ツールと Docker イメージのバージョンは [mise.toml](mise.toml) に定義する。

## ローカルでデモを開く

```sh
DEMO_MODE=true mise run anvil-up
DEMO_MODE=true APP_MODE=anvil mise run demo-seed
```

[http://localhost:3000](http://localhost:3000) を開く。送金、交換、遮断、監査の操作は [デモ手順](docs/09-flows.md) を参照する。
Anvil では Gateway とコントラクトの KYC 検査を確認できる。実行層の KYC 規則、L1 Deposit、Sequencer の切替は Sepolia DevNet を使う。

停止は `DEMO_MODE=true mise run anvil-down`。チェーンと PostgreSQL のデータは Docker ボリュームに残る。

## Sepolia DevNet を起動する

`.env.example` をもとに `.env` を作る。Sepolia の `L1_RPC_URL`、`L1_BEACON_URL`、新しく生成した `LEDGERA_MNEMONIC`、`POSTGRES_PASSWORD` を設定する。画面デモでは `DEMO_MODE=true` を使う。

`mise run keys` が表示する admin アドレスに Sepolia ETH を入れる。必要な残高と L1 に取引を送る手順は [開発と運用](docs/10-dev-ops.md#5-初回の立ち上げdevnet) を参照する。
起動後は [http://localhost:3000](http://localhost:3000) を開く。

- LAN から操作する場合は [Web 画面の LAN 公開](docs/10-dev-ops.md#71-web-画面の-lan-公開) を参照する。
- Sequencer 3 台の起動と障害試験は [チェーン層](docs/02-chain.md#11-冗長化要件-19) を参照する。
- 停止するときは `mise run app-down`、`mise run chain-down` の順に実行する。

## テスト

```sh
mise run lint
mise run test
mise run test-contracts
mise run test-integration
```

結合テストの追加設定と E2E は [開発と運用](docs/10-dev-ops.md#8-テスト) を参照する。

## 設計書

| ファイル | 内容 |
|---|---|
| [docs/00-overview.md](docs/00-overview.md) | 目的、スコープ、決定事項、用語、要件対応表 |
| [docs/01-architecture.md](docs/01-architecture.md) | 全体構成、コンポーネント、鍵とアカウント、リポジトリ構成 |
| [docs/02-chain.md](docs/02-chain.md) | OP Stack の構成、op-reth の改造、順序付け、手数料、検証ノードと対照ノード、冗長化 |
| [docs/03-contracts.md](docs/03-contracts.md) | Registry、トークン、トラベルルール、Forwarder、Swap、受付ログ、Deposit の確認用コントラクト |
| [docs/04-gateway.md](docs/04-gateway.md) | 受付 Gateway（到着順、Receipt、代理送信、コミット） |
| [docs/05-vasp.md](docs/05-vasp.md) | VASP サービス（KYC、ウォレット、トラベルルール、レート提示、AML） |
| [docs/06-consortium.md](docs/06-consortium.md) | コンソーシアムサービス（申請、承認、Safe 実行） |
| [docs/07-indexer-auditor.md](docs/07-indexer-auditor.md) | Indexer、監査 DB、到着順の監査ツール |
| [docs/08-web.md](docs/08-web.md) | デモ画面、デモ用ツール |
| [docs/09-flows.md](docs/09-flows.md) | デモ場面ごとのシーケンス、再演の手順 |
| [docs/10-dev-ops.md](docs/10-dev-ops.md) | 開発環境、環境変数、起動手順、ネットワーク構成、テスト |

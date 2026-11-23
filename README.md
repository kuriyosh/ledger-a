# ledgerA

KYC 済みアドレスだけが取引できる、金融向け Ethereum L2 の DevNet とデモ画面。

- 基盤: OP Stack（実行クライアントは op-reth の改造版）
- L1: Ethereum Sepolia
- 状態: M1（コントラクトと初期化）

## 開発用の鍵と RPC

Node.js 24.2 以降の 24 系と pnpm を用意し、`make setup` を実行する。
`.env.example` を `.env` にコピーする。新しく生成したニーモニックを
`LEDGERA_MNEMONIC="..."` の形式で設定する。
`make keys` はアドレスを表示し、秘密鍵とサービス用シークレットを
`.env.generated` に保存する。同じニーモニックで再実行すると、保存済みの
シークレットを再利用する。

読み取り専用 RPC を単独で起動するには、次を実行する。

```sh
UPSTREAM_L2_RPC_URLS=http://127.0.0.1:9545 pnpm --filter @ledgera/rpc-proxy start
```

op-node を使う場合は `UPSTREAM_ROLLUP_RPC_URLS` も指定する。
`make test` で単体テストを実行する。`make test-integration` は Docker で
anvil を起動し、有効な署名付き取引がプロキシ経由で拒否されることを確認する。

## anvil でコントラクトを初期化する

`make setup` の後に `make anvil-up` を実行する。
コントラクトのアドレスと監査開始ブロックは `deployments/anvil.json` に出力する。
読み取り専用 RPC は `127.0.0.1:8545`、直接送信は `127.0.0.1:9545` を使う。
`make anvil-down` で停止する。チェーンの状態は Docker ボリュームに保存される。

## Sepolia で DevNet を起動する

`.env` に Sepolia の `L1_RPC_URL` と `L1_BEACON_URL` を設定する。
`make keys` が表示する admin アドレスに Sepolia ETH を用意する。

```sh
make fund-l1
make chain-image
make chain-deploy
make chain-up
make l2-bootstrap
make status
```

ホストからは `http://127.0.0.1:8545` の読み取り専用 RPC に接続する。
L2 に直接送信する場合は `make chain-shell` を開く。
停止するには `make chain-down` を実行する。

## デモで見せること

- ルールを守らせるのは VASP のアプリではなくチェーンである
- ルールが守られたことを第三者が検証できる
- 個人情報はチェーンに載らない

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
| [docs/11-milestones.md](docs/11-milestones.md) | 実装計画と受け入れ基準 |
| [docs/12-open-issues.md](docs/12-open-issues.md) | 要検証事項、対象外の項目 |

読む順番は上から。実装を始める人は 00 → 01 → 11 を読み、担当マイルストーンの章へ進む。

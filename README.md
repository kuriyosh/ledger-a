# ledgerA

KYC 済みアドレスだけが取引できる、金融向け Ethereum L2 の DevNet とデモ画面。

- 基盤: OP Stack（実行クライアントは op-reth の改造版）
- L1: Ethereum Sepolia
- 状態: 設計完了、実装未着手

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

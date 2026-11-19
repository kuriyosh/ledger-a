# 10 開発と運用

## 1. 必要なツール

| ツール | 用途 |
|---|---|
| Docker、Docker Compose v2 | チェーンとサービスの起動 |
| Node.js 24、pnpm | サービス、画面、スクリプト |
| Foundry（forge、cast、anvil） | コントラクト、anvil モード |
| jq、make、openssl | スクリプト |
| Rust（fork の `rust/rust-toolchain.toml` の版） | チェーン改造を開発する人だけ |

op-deployer は `chain/scripts/deploy-l1.sh` が `chain/versions.env` の版を取得する。

## 2. 動作モード

| モード | L2 | L1 | 使いどころ |
|---|---|---|---|
| anvil | anvil 1 台（chain ID 31337） | なし | コントラクト、サービス、画面の開発。結合テスト。CI |
| devnet | OP Stack（Sequencer 1 台） | Sepolia | チェーン改造の確認。デモ。E2E |
| devnet-ha | OP Stack（Sequencer 3 台） | Sepolia | 場面 7 |

anvil モードでできないこと。

- 実行層の KYC 規則。未登録の送信者の取引も通る。
- L1 Deposit。
- 確定段階の表示（常に `unsafe`）。

anvil モードでも、Gateway の事前検査とトークンの検査は働く。場面 1〜3、5、6 は anvil モードで通る。

## 3. 設定ファイル

### 3.1 手で書くもの

`.env`（`.env.example` を写して作る）。

| 変数 | 例 | 説明 |
|---|---|---|
| `L1_RPC_URL` | - | Sepolia の RPC。API キー付きを推奨 |
| `L1_BEACON_URL` | `https://ethereum-sepolia-beacon-api.publicnode.com` | Sepolia の Beacon API |
| `LEDGERA_MNEMONIC` | - | 運営側アカウントの元。12 語か 24 語 |
| `L2_CHAIN_ID` | `20261` | |
| `BATCHER_MAX_CHANNEL_DURATION` | `25` | L1 ブロック数。デモ中は 5 |
| `DEMO_MODE` | `true` | |
| `POSTGRES_PASSWORD` | - | |

### 3.2 生成されるもの

`make keys` が `.env.generated` を作る。

| 内容 | 変数 |
|---|---|
| 運営側アカウントの秘密鍵とアドレス | `ADMIN_PRIVATE_KEY`、`ADMIN_ADDRESS`、`BATCHER_PRIVATE_KEY`、…（01 章 5.2 の全アカウント。名前の `-` を `_` にして大文字にし、`_PRIVATE_KEY`、`_ADDRESS` を付ける） |
| サービス間の認証 | `GATEWAY_ADMIN_TOKEN`、`VASP_A_ADMIN_TOKEN`、`VASP_B_ADMIN_TOKEN`、`CONSORTIUM_ADMIN_TOKEN`、`VASP_A_GATEWAY_API_KEY`、`VASP_B_GATEWAY_API_KEY`、`VASP_A_AUDITOR_KEY`、`VASP_B_AUDITOR_KEY` |
| 顧客の鍵の暗号化 | `VASP_A_KEY_ENCRYPTION_KEY`、`VASP_B_KEY_ENCRYPTION_KEY` |

`docker-compose.yml` は、この 2 ファイルの値を各サービスの環境変数（04〜08 章の設定表）に割り当てる。

### 3.3 git に入れないもの

`.env`、`.env.generated`、`chain/.deployer/`、`chain/runtime/`、`deployments/*.json`。`.gitignore` に書く。

## 4. Make ターゲット

| ターゲット | 内容 |
|---|---|
| `make setup` | `pnpm install`、`forge install`、ABI の生成 |
| `make keys` | アカウントを導出して `.env.generated` を作る。アドレスと必要な残高を表示する |
| `make fund-l1` | admin から batcher と attacker に Sepolia ETH を送る |
| `make chain-image` | fork を取得して op-reth のイメージを作る |
| `make chain-deploy` | L1 へのデプロイと設定の生成（02 章 3 節） |
| `make chain-up`、`chain-down`、`chain-logs` | op-reth、op-node、op-batcher |
| `make l2-bootstrap` | L2 の初期化（02 章 5 節） |
| `make app-up`、`app-down`、`app-logs` | postgres、各サービス、web |
| `make demo-seed` | デモ用の顧客と残高を作る |
| `make up`、`make down` | チェーンとアプリをまとめて起動、停止 |
| `make status` | 各コンポーネントの稼働、ブロック高、safe ブロック、通番、残高を表示する |
| `make replica-up`、`replica-compare` | 検証ノードの起動、ブロックハッシュの比較 |
| `make ha-up`、`ha-kill-leader`、`ha-restore` | 冗長化構成 |
| `make anvil-up`、`anvil-down` | anvil モード一式（anvil、初期化、アプリ） |
| `make test` | TypeScript の単体テスト |
| `make test-contracts` | `forge test` |
| `make test-integration` | anvil を使う結合テスト |
| `make e2e` | デモ場面の自動テスト |
| `make audit` | 監査ツールの CLI を通番 1 から実行する |
| `make lint`、`make fmt` | Biome、forge fmt |
| `make clean` | `chain/runtime` と DB のボリュームを消す。確認を求める |

## 5. 初回の立ち上げ（devnet）

| 順 | 操作 | 確認 |
|---:|---|---|
| 1 | `.env` を書く | - |
| 2 | `make setup` | - |
| 3 | `make keys` | アドレスの一覧が出る |
| 4 | admin のアドレスに Sepolia ETH を 3 ETH 入れる（faucet） | `cast balance` |
| 5 | `make fund-l1` | batcher が 0.5 ETH、attacker が 0.05 ETH |
| 6 | `make chain-image` | `docker images` に `ledgera/op-reth` がある |
| 7 | `make chain-deploy` | `chain/runtime/genesis.json` と `rollup.json` がある |
| 8 | `make chain-up` | `make status` でブロック高が増える |
| 9 | `make l2-bootstrap` | `deployments/devnet.json` がある。`enforcementEnabled()` が true |
| 10 | `make app-up` | 全サービスの `/healthz` が 200 |
| 11 | `make demo-seed` | 登録簿に顧客 4 人が出る |
| 12 | `http://localhost:3000` を開く | - |

- 手順 6 は初回に時間がかかる。Rust のフルビルドのため。
- 手順 7 は Sepolia に取引を送る。数分かかる。
- 2 回目以降は `make up` だけでよい。

`make demo-seed` の内容。

| VASP | 顧客 | 残高 |
|---|---|---|
| A | 鈴木 花子 | なし |
| B | Lim Wei | なし |
| B | Tan Mei | 1,000 tUSD |
| B | Lee Jun | なし |

各サービスの API を呼んで作る。申込、KYC の承認、発行の順。

## 6. anvil モード

```
make setup
make anvil-up
```

`make anvil-up` の内容。

1. `anvil --chain-id 31337 --order fifo --block-time 2` を起動する。
2. 固定のテスト用ニーモニックで `.env.generated` を作る。
3. `Bootstrap.s.sol` を `BOOTSTRAP_MODE=anvil` で実行する。`deployments/anvil.json` ができる。
4. アプリ層を起動する。`SEQUENCER_RPC_URLS` と `L2_RPC_URL` は anvil を指す。
5. `make demo-seed` を実行する。

## 7. Compose の構成

| ファイル | サービス |
|---|---|
| `docker-compose.yml` | postgres、gateway、vasp-a、vasp-b、consortium、indexer、auditor、demo-tools、web |
| `chain/compose/docker-compose.chain.yml` | op-reth、op-node、op-batcher |
| `chain/compose/docker-compose.replica.yml` | op-reth-replica、op-node-replica |
| `chain/compose/docker-compose.ha.yml` | op-reth-1〜3、op-node-1〜3、op-conductor-1〜3、op-batcher |
| `docker-compose.anvil.yml` | anvil |

- すべて同じ Docker ネットワーク `ledgera` に入れる。
- 起動順は `depends_on` と healthcheck で決める。postgres → gateway → その他のサービス → web。
- ホストに出すポートは 01 章 2.2 のとおり。op-reth は 8545（HTTP）と 8546（WS）、op-node は 8547。

DB。

- postgres は 1 つ。データベース名は `ledgera`。
- スキーマはサービスごと（`gateway`、`vasp_a`、`vasp_b`、`consortium`、`indexer`、`auditor`）。
- 各サービスは起動時に自分のスキーマのマイグレーションを実行する。
- DB ユーザーは 1 つ（`ledgera`、パスワードは `POSTGRES_PASSWORD`）。各サービスは接続時に自分のスキーマだけを `search_path` に入れ、ほかのスキーマを読まない。

op-reth の RPC。

- 読み取りのためにホストへ出す。書き込みは Gateway を通す運用にする。
- ポートを分けて書き込みを塞ぐことはしない。直接の書き込みは、未登録ならプール検査が拒否し、登録済みなら監査ツールの C6 が検出する。

## 8. テスト

### 8.1 層

| 層 | 対象 | 道具 | 実行環境 |
|---|---|---|---|
| チェーン改造 | op-revm の判定、op-reth のプール検査 | cargo test | fork リポジトリ |
| コントラクト | 03 章の各「テスト」節 | forge test | ローカル、CI |
| 単体 | 各サービスの `domain/` | Vitest | ローカル、CI |
| 結合 | サービス ＋ postgres ＋ anvil | Vitest | ローカル、CI |
| E2E | デモ場面 | Vitest | anvil モード、devnet |

### 8.2 言語をまたぐ一致の確認

同じ計算を複数の言語で行う箇所は、共通のテストベクタで確認する。

| 計算 | 実装 | テストベクタの置き場 |
|---|---|---|
| Registry のスロットとビット配置 | Rust（op-revm）、Solidity | 02 章 6.2 |
| Receipt の `entryHash` と署名 | TypeScript、Solidity | `packages/shared/test/vectors/receipt.json` |
| 承認（`TravelRuleAttestation`）の署名 | TypeScript、Solidity | `packages/shared/test/vectors/attestation.json` |
| `Quote` の署名 | TypeScript、Solidity | `packages/shared/test/vectors/quote.json` |
| `ForwardRequest` の署名 | TypeScript、Solidity（OZ） | `packages/shared/test/vectors/forward-request.json` |

テストベクタは TypeScript 側で生成し、Foundry のテストが `vm.readFile` で読む。

### 8.3 E2E

`e2e/scenes/` に場面ごとのファイルを置く。検証項目は 09 章の各「確認点」。

| ファイル | 場面 | anvil | devnet |
|---|---|:-:|:-:|
| `scene1-onboarding.test.ts` | 1 | ○ | ○ |
| `scene2-swap.test.ts` | 2 | ○ | ○ |
| `scene3-transfer.test.ts` | 3 | ○ | ○ |
| `scene4-bypass.test.ts` | 4 の手順 1〜5 | - | ○ |
| `scene4-token-rules.test.ts` | 4 の手順 6、7 | ○ | ○ |
| `scene5-freeze.test.ts` | 5 | ○ | ○ |
| `scene6-audit.test.ts` | 6 | ○ | ○ |
| `scene7-failover.test.ts` | 7 | - | devnet-ha |

- E2E は API を呼ぶ。画面は操作しない。
- テストごとに新しい顧客を作る。チェーンの状態を前提にしない。
- 手動承認の箇所（KYC、トラベルルール、開示）は管理者用の API を呼んで進める。

### 8.4 CI

このリポジトリの GitHub Actions。

| ジョブ | 内容 |
|---|---|
| lint | Biome、`forge fmt --check` |
| contracts | `forge test` |
| unit | `make test` |
| integration | postgres のサービスコンテナと anvil を起動して `make test-integration` |
| e2e-anvil | `make anvil-up` の後に `make e2e` |

devnet の E2E は CI で動かさない。Sepolia ETH と時間がかかるため。マイルストーンの完了時に手で実行する。

fork リポジトリの CI は、変更した 2 クレートの `cargo test` だけを動かす。

## 9. 運用

### 9.1 費用（Sepolia ETH）

| 費用 | 頻度 |
|---|---|
| L1 へのデプロイ | 環境を作るたびに 1 回。必要量は M0 で実測する |
| Batch の投稿 | チェーンが動いている間、`BATCHER_MAX_CHANNEL_DURATION` ごと |
| Deposit のデモ | 1 回あたり 0.001 ETH とガス代 |

使わないときは `make down` で止める。止めている間は Batch を投稿しない。

### 9.2 監視

`make status` が次を表示する。

| 項目 | 取得元 | 異常の目安 |
|---|---|---|
| L2 のブロック高 | op-reth | 10 秒増えない |
| safe ブロック | op-node の `optimism_syncStatus` | unsafe との差が 30 分ぶん以上 |
| batcher の Sepolia 残高 | L1 | 0.05 ETH 未満 |
| Gateway の最新通番とコミット済み通番 | gateway の `/v1/status` | 差が開き続ける |
| Gateway のキュー | 同上 | 0 に戻らない |
| 運営側アカウントの L2 残高 | op-reth | 0.1 ETH 未満 |
| 監査の違反件数 | auditor の `/v1/fifo/summary` | デモの仕掛け以外で増える |

### 9.3 秘密情報

- ニーモニックと `.env.generated` は共有ストレージに置かない。環境ごとに作り直す。
- DevNet の鍵を、価値のある資産を持つアドレスに使い回さない。
- 個人情報は架空のものだけを入れる。

### 9.4 バックアップ

- DevNet ではバックアップを取らない。
- L2 の状態は L1 の Batch から再構築できる。Batch 未投稿のブロックと、各サービスの DB は失われる。
- Gateway の DB を失うと、受付ログの連鎖が途切れる。その場合は環境を作り直す。

## 10. 困ったとき

| 症状 | 原因と対処 |
|---|---|
| op-node が L1 を読めない、遅れる | L1 の RPC の回数制限。API キー付きのプロバイダに替える |
| Deposit が L2 に入らない | L1 の確認待ち。2 分待つ。op-node のログで L1 の取得を確認する |
| 運営側アカウントで `ledgera: sender not allowed` | Registry に未登録。`cast call` で `getAccount` を確認する |
| 初期化の途中で失敗した | `make l2-bootstrap` をやり直す。済んだ手順は飛ばされる（02 章 5 節） |
| Gateway が `NONCE_GAP` を返す | Gateway を通さない送信で nonce がずれた。Gateway を再起動すると期待値を読み直す |
| safe ブロックが進まない | batcher の残高不足か、L1 の RPC の障害。`make chain-logs` で op-batcher を見る |
| 規則の有効化後に Registry を直したい | コンソーシアム画面から `RAW` の申請を出し、2 者の承認で実行する |
| op-reth のイメージのビルドが失敗する | fork の `superchain-registry` サブモジュールが取得できているか確認する |

# 10 開発と運用

## 1. 必要なツール

| ツール | 用途 |
|---|---|
| Docker、Docker Compose v2 | チェーンとサービスの起動 |
| Node.js 24、pnpm | サービス、画面、スクリプト |
| Foundry（forge、cast、anvil） | コントラクト、anvil モード |
| jq、make、openssl | スクリプト |
| Rust（fork の `rust/rust-toolchain.toml` のバージョン） | チェーン改造を開発する人だけ |

op-deployer は、`chain/scripts/deploy-l1.sh` が `chain/versions.env` で指定したバージョンを取得する。

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

anvil モードでも、Gateway の事前検査、`LedgerForwarder` の署名者の検査、トークンの検査は働く。場面 1〜3、5、6 は anvil モードで通る。

## 3. 設定ファイル

### 3.1 手で書くもの

`.env`（`.env.example` を写して作る）。

| 変数 | 例 | 説明 |
|---|---|---|
| `L1_RPC_URL` | - | Sepolia の RPC。API キー付きを推奨 |
| `L1_BEACON_URL` | `https://ethereum-sepolia-beacon-api.publicnode.com` | Sepolia の Beacon API |
| `LEDGERA_MNEMONIC` | - | 運営側アカウントの元。12 語か 24 語 |
| `L2_CHAIN_ID` | `202610` | |
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

`docker-compose.yml` はこの 2 ファイルの値を各サービスの環境変数（04〜08 章の設定表）に割り当てる。

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
| `make chain-up`、`chain-down`、`chain-logs` | op-reth、op-node、op-batcher、rpc-proxy |
| `make chain-shell` | `ledgera-chain` ネットワークにつないだ Foundry コンテナのシェルを開く。op-reth に直接 `cast` を使うときに使う |
| `make l2-bootstrap` | L2 の初期化（02 章 5 節）。`ledgera-chain` ネットワークにつないだ Foundry コンテナで実行する |
| `make app-up`、`app-down`、`app-logs` | postgres、各サービス、web |
| `make demo-seed` | 新しいデモ回を作る。登場人物と残高を作り、画面と監査の集計を新しい回に切り替える |
| `make up`、`make down` | チェーンとアプリをまとめて起動、停止 |
| `make status` | 各コンポーネントの稼働、ブロック高、safe ブロック、通番、残高を表示する |
| `make replica-up`、`replica-compare` | 検証ノードの起動、ブロックハッシュの比較 |
| `make control-up`、`control-compare`、`control-down` | 対照ノードの起動、Deposit の結果の比較、データごとの削除（02 章 10.2） |
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
| 7 | `make chain-deploy` | `chain/runtime/genesis.json` と `rollup.json` がある。L1 の `SystemConfig` の `basefeeScalar()` と `blobbasefeeScalar()` が 0 |
| 8 | `make chain-up` | `make status` でブロック高が増える |
| 9 | `make l2-bootstrap` | `deployments/devnet.json` がある。`enforcementEnabled()` が true。レシートの `l1Fee` が 0 |
| 10 | `make app-up` | 全サービスの `/healthz` が 200 |
| 11 | `make demo-seed` | 登録簿に顧客 4 人が出る |
| 12 | `http://localhost:3000` を開く | - |

- 手順 6 は初回に時間がかかる。Rust のフルビルドのため。
- 手順 7 は Sepolia に取引を送る。数分かかる。
- 2 回目以降は `make up` だけでよい。
- デモを再演するときは、`make demo-seed` をもう一度実行する（09 章 9 節）。

`make demo-seed` の内容。demo-tools の `POST /v1/demo/runs` を呼ぶ（08 章 10.1）。

| VASP | 顧客 | 残高 |
|---|---|---|
| A | 鈴木 花子 | なし |
| B | Lim Wei | なし |
| B | Tan Mei | 1,000 tUSD |
| B | Lee Jun | なし |

- demo-tools が各 VASP の API を呼んで作る。申込、KYC の承認、発行の順。
- 実行のたびに回の番号が 1 増える。メールアドレスは回ごとに変わる（例: `lim.r3@example.com`）。同じ氏名で別のアドレスの顧客になる。
- その時点の通番とブロックを、回の開始位置として記録する。

## 6. anvil モード

```
make setup
make anvil-up
```

`make anvil-up` の内容。

1. `anvil --chain-id 31337 --order fifo --block-time 2` と rpc-proxy を起動する。rpc-proxy の転送先は anvil。
2. 固定のテスト用ニーモニックで `chain/runtime/anvil/.env.generated` を作る。
3. `Bootstrap.s.sol` を `BOOTSTRAP_MODE=anvil` で実行する。`deployments/anvil.json` ができる。
4. アプリ層を起動する。`SEQUENCER_RPC_URLS` は anvil、`L2_RPC_URL` は rpc-proxy を指す。
5. `make demo-seed` を実行する。

- anvil の直接 RPC は `127.0.0.1:9545` に出す。読み取り専用 RPC は `127.0.0.1:8545` に出す。結合テストが再編成（`evm_revert`）と、Gateway を通さない送信を使うため。
- 結合テストはサービスを Vitest の中で起動する。rpc-proxy を通さず、anvil に直接つなぐ。

## 7. Compose の構成

| ファイル | サービス |
|---|---|
| `docker-compose.yml` | postgres、gateway、vasp-a、vasp-b、consortium、indexer、auditor、demo-tools、web |
| `chain/compose/docker-compose.chain.yml` | op-reth、op-node、op-batcher、rpc-proxy |
| `chain/compose/docker-compose.replica.yml` | op-reth-replica、op-node-replica。プロファイル `control` に op-reth-control、op-node-control |
| `chain/compose/docker-compose.ha.yml` | op-reth-1〜3、op-node-1〜3、op-conductor-1〜3、op-batcher、rpc-proxy |
| `docker-compose.anvil.yml` | anvil、rpc-proxy |

ネットワーク。Docker ネットワークを 2 つに分ける。

| ネットワーク | 入るもの | 用途 |
|---|---|---|
| `ledgera-chain` | op-reth、op-node、op-batcher、op-conductor、rpc-proxy、gateway、demo-tools | op-reth と op-node の RPC に直接つなぐ |
| `ledgera` | postgres、rpc-proxy、gateway、vasp-a、vasp-b、consortium、indexer、auditor、demo-tools、web、検証ノード、対照ノード | サービス間の通信と、rpc-proxy 経由の読み取り |

- 起動順は `depends_on` と healthcheck で決める。postgres と rpc-proxy → gateway → その他のサービス → web。
- ホストに出すポートは 01 章 2.2 のとおり。op-reth と op-node のポートはホストに出さない。
- 検証ノードと対照ノードは `ledgera` に入れる。Sequencer と P2P でつながず、取引の転送先も設定しないので、取引を送ってもブロックに入らない。

DB。

- postgres は 1 つ。データベース名は `ledgera`。
- スキーマはサービスごと（`gateway`、`vasp_a`、`vasp_b`、`consortium`、`indexer`、`auditor`、`demo`）。rpc-proxy は DB を使わない。
- 各サービスは起動時に自分のスキーマのマイグレーションを実行する。
- DB ユーザーは 1 つ（`ledgera`、パスワードは `POSTGRES_PASSWORD`）。各サービスは接続時に自分のスキーマだけを `search_path` に入れ、ほかのスキーマを読まない。

op-reth の RPC。到着順の前提「取引を受け付けるのは Gateway だけ」（02 章 7.1）を、ネットワークの構成で担保する。

- op-reth の HTTP（8545）と WS（8546）は、`ledgera-chain` の中だけで待ち受ける。ホストにも `ledgera` にも出さない。
- op-reth に取引を送れるのは、`ledgera-chain` に入っている gateway と demo-tools だけ。
- demo-tools が直接送るのは、場面 4 の外部者（未登録）の取引だけ。規則で拒否され、ブロックに入らない。
- ほかのサービスとホストは、rpc-proxy を通して読む。vasp、consortium、indexer、auditor は、鍵を持っていても op-reth に取引を送れない。
- 初期化（`make l2-bootstrap`）と、op-reth への直接の `cast`（`make chain-shell`）は、`ledgera-chain` につないだ一時的なコンテナで行う。
- ネットワークの分離は、運営者自身の直接送信を止めない。運営者が Gateway を通さずに送った取引は、監査ツールの C6 が検出する。

rpc-proxy。JSON-RPC のメソッド名を見て、読み取りだけを中継する。

| パス | 転送先 | 通すメソッド |
|---|---|---|
| `/` | op-reth | `eth_chainId`、`eth_blockNumber`、`eth_getBlockByNumber`、`eth_getBlockByHash`、`eth_getBlockReceipts`、`eth_getTransactionByHash`、`eth_getTransactionReceipt`、`eth_getTransactionCount`、`eth_getBalance`、`eth_getCode`、`eth_getStorageAt`、`eth_call`、`eth_estimateGas`、`eth_getLogs`、`eth_feeHistory`、`eth_gasPrice`、`eth_maxPriorityFeePerGas`、`net_version`、`web3_clientVersion`、`debug_traceTransaction` |
| `/rollup` | op-node | `optimism_syncStatus`、`optimism_rollupConfig` |

- 表にないメソッドは `-32601` で拒否する。`eth_sendRawTransaction`、`eth_sendTransaction`、`txpool_*`、`admin_*` を含む。
- 許可リスト方式にする。拒否リスト方式だと、取引を送るメソッドが増えたときに漏れる。
- バッチリクエストは、表にないメソッドが 1 件でもあれば全体を拒否する。
- WebSocket は中継しない。サービスはポーリングで読む。
- 冗長化構成では転送先を 3 組指定する。1 秒ごとに各 op-reth の `eth_blockNumber` を読み、ブロック高が最も高い組に転送する。
- 状態を持たない。

rpc-proxy の設定。

| 環境変数 | 既定 | 説明 |
|---|---|---|
| `HOST` | 127.0.0.1 | コンテナ内では 0.0.0.0 |
| `PORT` | 8545 | |
| `UPSTREAM_L2_RPC_URLS` | - | op-reth の URL。冗長化構成ではカンマ区切りで 3 つ |
| `UPSTREAM_ROLLUP_RPC_URLS` | - | op-node の URL。`UPSTREAM_L2_RPC_URLS` と同じ順。anvil モードでは空 |

rpc-proxy のテスト。

| 種類 | 内容 |
|---|---|
| 単体 | 表のメソッドが中継される。表にないメソッドと、それを含むバッチが `-32601` になる |
| 結合（anvil） | rpc-proxy 経由の `eth_sendRawTransaction` が拒否され、取引がブロックに入らない |
| 単体 | 転送先が 3 つのとき、ブロック高が最も高い転送先が選ばれる。止まった転送先を避ける |

## 8. テスト

### 8.1 層

| 層 | 対象 | ツール | 実行環境 |
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
- 実行の最初に新しいデモ回を作る。登場人物はその回の顧客を使う。チェーンの状態を前提にしない。
- 監査の確認は、その回の開始通番と開始ブロック以降を対象にする。前の実行で起こした違反の影響を受けない。
- 残高、nonce、カウンタ、Registry のバージョンは、操作の前後の差で確かめる。
- 手動承認の箇所（KYC、トラベルルール、開示）は管理者用の API を呼んで進める。
- `scene4-bypass` の対照の Deposit（登録済みの送信者）は、テストが admin の鍵で Sepolia に直接送る。

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

- DevNet ではバックアップを取らない。復旧の手順も用意しない。
- L2 の状態は L1 の Batch から再構築できる。Batch 未投稿のブロックは失われる。
- indexer の DB は L2 から取り込み直せる（07 章 2.1）。
- Gateway の DB を失うと、受付ログの連鎖が途切れる。その場合は環境を作り直す。
- VASP、コンソーシアム、監査ツール、demo-tools の DB も復旧しない。失ったら環境を作り直す。

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
| ホストからの `cast send` が `-32601` で拒否される | ホストに出ている RPC は読み取り専用の rpc-proxy。取引は Gateway の `/rpc` に送る。op-reth に直接送る必要があるときは `make chain-shell` を使う |
| 外部者の直接送信が残高不足のエラーになる | 先に Deposit を行う。L2 残高が必要な残高（08 章 10.1 の表）に足りているかを外部者画面で確認する |
| 2 回目のデモで Lim さんへの送金が失敗する | 前の回の Lim さんは遮断済み。`make demo-seed` で新しい回を作る |
| 新しい申請が `PROPOSAL_IN_PROGRESS` で拒否される | 実行に失敗した申請か、取り下げ中の申請が残っている。再実行するか、2 人目が取り下げを完了する |
| 対照ノードのブロック高が進まない | 未登録アドレスの Deposit を含むブロックで分岐した後は進まない。`make control-down` で消す |
| op-reth のイメージのビルドが失敗する | fork の `superchain-registry` サブモジュールが取得できているか確認する |

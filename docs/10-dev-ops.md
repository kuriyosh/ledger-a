# 10 開発と運用

## 1. 必要なツール

| ツール | 用途 |
|---|---|
| mise 2026.7.10 以降 | タスクの実行と開発ツールのバージョン管理 |
| Docker、Docker Compose 2.24.4 以降 | チェーンとサービスの起動 |
| Bash、Git、curl、OpenSSL | セットアップと運用スクリプト |
| Rust（fork の `rust/rust-toolchain.toml` のバージョン） | チェーン改造を開発する人だけ |

リポジトリのルートで `mise trust` と `mise install` を実行する。Node.js、pnpm、Foundry、jq、ripgrep は `mise.toml` の指定に従って入る。

op-deployer は、`chain/scripts/deploy-l1.sh` が `mise.toml` で指定したバージョンを取得する。

## 2. 動作モード

| モード | L2 | L1 | 使いどころ |
|---|---|---|---|
| anvil | anvil 1 台（chain ID 31337） | なし | コントラクト、サービス、画面の開発。結合テスト |
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
| `L1_RPC_URL` | - | Sepolia の実行 RPC。API キーなしの公開 RPC も使える |
| `L1_BEACON_URL` | `https://ethereum-sepolia-beacon-api.publicnode.com` | Sepolia の Beacon API |
| `LEDGERA_MNEMONIC` | - | 運営側アカウントの元。12 語か 24 語 |
| `L2_CHAIN_ID` | `202610` | |
| `BATCHER_MAX_CHANNEL_DURATION` | `25` | L1 ブロック数。デモ中は 5 |
| `DEMO_MODE` | `true` | デモ用 API と画面操作を有効にする。`.env.example` は `true`。未設定時は無効 |
| `POSTGRES_PASSWORD` | - | DevNet で必須。Anvil は未設定ならローカル試験用の値を使う |
| `WEB_ALLOWED_ORIGIN` | 空 | LAN から操作するときの Web の接続先。設定方法は 7.1 |

### 3.2 生成されるもの

`mise run keys` は `.env.generated` と `.env.auditor.generated` を作る。
ニーモニックが同じなら、保存済みのサービス用シークレットを再利用する。
Anvil は `chain/runtime/anvil/` に対応する 2 ファイルを作る。

| 内容 | 変数 |
|---|---|
| 運営側アカウントの秘密鍵とアドレス | `ADMIN_PRIVATE_KEY`、`ADMIN_ADDRESS`、`BATCHER_PRIVATE_KEY`、…（01 章 5.2 の全アカウント。名前の `-` を `_` にして大文字にし、`_PRIVATE_KEY`、`_ADDRESS` を付ける） |
| サービス間の認証 | `GATEWAY_ADMIN_TOKEN`、`VASP_A_ADMIN_TOKEN`、`VASP_B_ADMIN_TOKEN`、`CONSORTIUM_ADMIN_TOKEN`、`VASP_A_GATEWAY_API_KEY`、`VASP_B_GATEWAY_API_KEY`、`VASP_A_AUDITOR_KEY`、`VASP_B_AUDITOR_KEY` |
| 顧客の鍵の暗号化 | `VASP_A_KEY_ENCRYPTION_KEY`、`VASP_B_KEY_ENCRYPTION_KEY` |
| 監査者の認証（`.env.auditor.generated`） | `AUDITOR_ADMIN_TOKEN` |

`docker-compose.yml` は設定と生成ファイルの値を各サービスの環境変数に割り当てる。イメージのバージョンは `mise.toml` に設定する。

### 3.3 git に入れないもの

`.env`、`.env.generated`、`.env.auditor.generated`、`chain/.deployer/`、`chain/runtime/`、`deployments/*.json` は Git の管理対象外。

## 4. mise タスク

| コマンド | 内容 |
|---|---|
| `mise run setup` | 依存パッケージと Git サブモジュールを取得し、ABI を生成する |
| `mise run keys` | アカウントを導出して `.env.generated` を作る。アドレスと必要な残高を表示する |
| `mise run fund-l1` | admin から batcher と attacker に Sepolia ETH を送る |
| `mise run chain-image` | `mise.toml` で固定した fork のコミットから、op-reth のイメージを作る |
| `mise run chain-deploy` | L1 へのデプロイと設定の生成（02 章 3 節） |
| `mise run chain-up`、`chain-down`、`chain-logs` | op-reth、op-node、op-batcher、rpc-proxy |
| `mise run chain-shell` | `ledgera-chain` ネットワークにつないだ Foundry コンテナのシェルを開く。op-reth に直接 `cast` を使うときに使う |
| `mise run l2-bootstrap` | L2 の初期化（02 章 5 節）。`ledgera-chain` ネットワークにつないだ Foundry コンテナで実行する |
| `mise run app-up`、`app-down`、`app-logs` | postgres、各サービス、web |
| `mise run demo-seed` | 新しいデモ回を作る。登場人物と残高を作り、画面と監査の集計を新しい回に切り替える |
| `mise run status` | DevNet のチェーン側サービス、L1・L2 のブロック高、safe ブロック、運営側の残高を表示する |
| `mise run replica-up`、`replica-down`、`replica-reset`、`replica-compare` | 検証ノードの起動と停止、データの削除、ブロックハッシュの比較 |
| `mise run control-up`、`control-compare`、`control-down` | 対照ノードの起動、Deposit の結果の比較、データごとの削除（02 章 10.2） |
| `mise run ha-up`、`ha-kill-leader`、`ha-restore` | 冗長化構成 |
| `mise run anvil-up`、`anvil-down` | anvil モード一式（anvil、初期化、アプリ） |
| `mise run test` | TypeScript の単体テスト |
| `mise run test-contracts` | `forge test` |
| `mise run test-integration` | anvil を使う結合テスト |
| `mise run e2e`、`e2e-fifo` | デモ場面と個人情報の保存先の検査、100 取引の順序の検査 |
| `mise run audit` | 監査ツールの CLI を通番 1 から実行する |
| `mise run lint`、`mise run fmt` | Biome、forge fmt |

`mise tasks` でタスクの一覧を表示できる。`APP_MODE` を使うときは `APP_MODE=anvil mise run app-up` のように指定する。

ホストのポートや Docker ネットワークを変更する場合は、追加の Compose ファイルを指定する。

| 対象 | 環境変数 |
|---|---|
| DevNet と冗長化構成 | `LEDGERA_CHAIN_COMPOSE_OVERLAY` |
| 検証ノードと対照ノード | `LEDGERA_REPLICA_COMPOSE_OVERLAY` |
| Anvil | `LEDGERA_ANVIL_COMPOSE_OVERLAY` |
| アプリ | `LEDGERA_APP_COMPOSE_OVERLAY` |

初期化に使うネットワーク名と読み取り RPC のポートを変更した場合は、`BOOTSTRAP_NETWORK` と `BOOTSTRAP_READ_RPC` も指定する。

## 5. 初回の立ち上げ（devnet）

| 順 | 操作 | 確認 |
|---:|---|---|
| 1 | `.env` を書く。画面デモと E2E では `DEMO_MODE=true` を設定する | - |
| 2 | `mise run setup` | - |
| 3 | `mise run keys` | アドレスの一覧が出る |
| 4 | admin のアドレスに Sepolia ETH を 3 ETH 入れる（faucet） | `cast balance` |
| 5 | `mise run fund-l1` | batcher が 0.5 ETH、attacker が 0.05 ETH |
| 6 | `mise run chain-image` | `docker images` に `ledgera/op-reth` がある |
| 7 | `mise run chain-deploy` | `chain/runtime/genesis.json` と `rollup.json` がある。L1 の `SystemConfig` の `basefeeScalar()` と `blobbasefeeScalar()` が 0 |
| 8 | `mise run chain-up` | `mise run status` でブロック高が増える |
| 9 | `mise run l2-bootstrap` | `deployments/devnet.json` がある。`enforcementEnabled()` が true。レシートの `l1Fee` が 0 |
| 10 | `mise run app-up` | Compose のヘルスチェックが通る |
| 11 | `mise run demo-seed` | 登録簿に顧客 6 人が出る |
| 12 | `http://localhost:3000` を開く | - |

- 手順 6 は初回に時間がかかる。Rust のフルビルドのため。ソースは `OPTIMISM_FORK_COMMIT` で指定する。`chain-up` と `replica-up` はローカルイメージのコミットを照合する。
- 手順 7 は Sepolia に取引を送る。数分かかる。
- 2 回目以降は `mise run chain-up`、`mise run app-up` の順に実行する。
- デモを再演するときは、`mise run demo-seed` をもう一度実行する（09 章 9 節）。

`mise run demo-seed` の内容。demo-tools の `POST /v1/demo/runs` を呼ぶ（08 章 10.1）。

| VASP | 顧客 | 残高 |
|---|---|---|
| A | 鈴木 花子 | なし |
| A | 未登録宛て検証、確認省略検証 | 各 1,000 tJPY |
| B | Lim Wei | なし |
| B | Tan Mei | 1,000 tUSD |
| B | Lee Jun | なし |

- demo-tools が各 VASP の API を呼んで作る。申込、KYC の承認、発行の順。
- 実行のたびに回の番号が 1 増える。メールアドレスは回ごとに変わる（例: `lim.r3@example.com`）。同じ氏名で別のアドレスの顧客になる。
- その時点の通番とブロックを、回の開始位置として記録する。

## 6. anvil モード

標準の設定では、Anvil と DevNet は同じホストポートと Docker ネットワーク名を使う。先に使用中のモードを停止する。
セットアップ後、画面デモを起動する。

```sh
export DEMO_MODE=true
mise run anvil-up
APP_MODE=anvil mise run demo-seed
```

`http://localhost:3000` を開く。場面 5 で Anvil の確定を進めるときは `mise run e2e-anvil-finalize` を使う。停止は `mise run anvil-down`。

`mise run anvil-up` の内容。

1. `anvil --chain-id 31337 --order fifo --block-time 2` と rpc-proxy を起動する。rpc-proxy の転送先は anvil。
2. 固定のテスト用ニーモニックで `chain/runtime/anvil/.env.generated` を作る。
3. `Bootstrap.s.sol` を `BOOTSTRAP_MODE=anvil` で実行する。`deployments/anvil.json` ができる。
4. `APP_MODE=anvil mise run app-up` でアプリを起動する。PostgreSQL のパスワードが未設定なら、ローカル試験用の既定値を使う。

Anvil モードでは Gateway の転送先は `http://anvil:8545`。Auditor の読み取り先は `http://rpc-proxy:8545`。

- anvil の直接 RPC は `127.0.0.1:9545` に出す。読み取り専用 RPC は `127.0.0.1:8545` に出す。結合テストが再編成（`evm_revert`）と、Gateway を通さない送信を使うため。
- 結合テストはサービスを Vitest の中で起動する。rpc-proxy を通さず、anvil に直接つなぐ。

ローカルの Anvil 環境を初期状態に戻す場合は、アプリと Anvil を停止し、両方のボリュームとデプロイ結果を削除する。この操作で Anvil の取引履歴と PostgreSQL のデータが消える。

```sh
DEMO_MODE=true mise exec -- bash chain/scripts/app-compose.sh anvil down --volumes
mise exec -- bash chain/scripts/compose.sh anvil down --volumes
rm -f deployments/anvil.json
DEMO_MODE=true mise run anvil-up
```

## 7. Compose の構成

| ファイル | サービス |
|---|---|
| `docker-compose.yml` | postgres、gateway、vasp-a、vasp-b、consortium、indexer、auditor、demo-tools、web |
| `chain/compose/docker-compose.chain.yml` | op-reth、op-node、op-batcher、rpc-proxy |
| `chain/compose/docker-compose.replica.yml` | op-reth-replica、op-node-replica。プロファイル `control` に op-reth-control、op-node-control |
| `chain/compose/docker-compose.ha.yml` | op-reth-1〜3、op-node-1〜3、op-conductor-1〜3、op-batcher、rpc-proxy |
| `docker-compose.anvil.yml` | anvil、rpc-proxy |
| `docker-compose.enforcement-demo.yml` | L1 Deposit と直接送信の設定。DevNet または HA で `DEMO_MODE=true` のとき、アプリの起動時に自動で読み込む |

ネットワーク。Docker ネットワークを 2 つに分ける。

| ネットワーク | 入るもの | 用途 |
|---|---|---|
| `ledgera-chain` | op-reth、op-node、op-batcher、op-conductor、rpc-proxy、gateway、demo-tools | op-reth と op-node の RPC に直接つなぐ |
| `ledgera` | postgres、rpc-proxy、gateway、vasp-a、vasp-b、consortium、indexer、auditor、demo-tools、web、検証ノード、対照ノード | サービス間の通信と、rpc-proxy 経由の読み取り |

- 起動順は `depends_on` と healthcheck で決める。postgres と rpc-proxy → gateway → その他のサービス → web。
- ホストに出すポートは 01 章 2.2 のとおり。op-reth と op-node のポートはホストに出さない。
- 検証ノードと対照ノードの op-node は `ledgera` に入れる。各 op-reth はそれぞれの内部ネットワークに置く。両方とも Sequencer と P2P でつながず、L1 の Batch から導出する。
- genesis を作り直す場合は `mise run replica-reset` と `mise run control-down` で検証用のデータを削除する。
- Anvil で作ったローカル L1 フォークを使うときは、`L1_TRUST_RPC=true` を設定できる。公開 Sepolia では既定値の `false` を使う。

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
- 初期化（`mise run l2-bootstrap`）と、op-reth への直接の `cast`（`mise run chain-shell`）は、`ledgera-chain` につないだ一時的なコンテナで行う。
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

読み取り専用 RPC だけを起動する場合は、Anvil の直接 RPC を転送先に設定する。op-node を使う場合は `UPSTREAM_ROLLUP_RPC_URLS` も指定する。

```sh
UPSTREAM_L2_RPC_URLS=http://127.0.0.1:9545 mise exec -- pnpm --filter @ledgera/rpc-proxy start
```

### 7.1 Web 画面の LAN 公開

標準では Web の `3000` 番ポートはホストのループバックで待ち受ける。LAN に出す場合は、ホストの LAN アドレスとポートを Compose の追加ファイルに指定する。既存のポート割り当ては `!override` で置き換える。次は `192.168.100.30:18374` で待ち受ける例。 [Compose のマージ規則](https://docs.docker.com/reference/compose-file/merge/#replace-value)

```yaml
services:
  web:
    ports: !override
      - "192.168.100.30:18374:3000"
```

追加ファイルをリポジトリのルートに `compose.lan.yml` として保存し、アクセス先と同じオリジンを指定してアプリを起動する。

```sh
export LEDGERA_APP_COMPOSE_OVERLAY="$PWD/compose.lan.yml"
export WEB_ALLOWED_ORIGIN=http://192.168.100.30:18374
mise run app-up
```

ブラウザで `http://192.168.100.30:18374` を開く。Anvil では `APP_MODE=anvil mise run app-up` を使う。HA では `APP_MODE=devnet-ha mise run app-up` を使う。停止時も同じ追加ファイルとモードを指定する。管理 API にアクセスできるため、デモ用の閉じたネットワークで使う。

## 8. テスト

### 8.1 層

| 層 | 対象 | ツール | 実行環境 |
|---|---|---|---|
| チェーン改造 | op-revm の判定、op-reth のプール検査 | cargo test | fork リポジトリ |
| コントラクト | 03 章の各「テスト」節 | `mise run test-contracts` | ローカル |
| 単体 | 各サービス、共通ライブラリ、Web の API 中継 | `mise run test` | ローカル |
| 結合 | サービス、PostgreSQL、Anvil | `mise run test-integration` | ローカル |
| E2E | デモ場面、FIFO、個人情報の保存先 | `mise run e2e`、`e2e-fifo` | Anvil、DevNet、DevNet HA |

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
| `scene1-5.test.ts` | 1〜3、4 の手順 6、7、5 | ○ | ○ |
| `scene4-enforcement.test.ts` | 4 の手順 1〜5 | - | ○ |
| `scene6-audit.test.ts` | 6 | ○ | ○ |
| `scene7-failover.test.ts` | 7 | - | devnet-ha |

- E2E は API を呼ぶ。画面は操作しない。
- 起動済みの環境で `DEMO_MODE=true` を設定して実行する。最初に新しいデモ回を作る。登場人物はその回の顧客を使う。
- 監査の確認は、その回の開始通番と開始ブロック以降を対象にする。前の実行で起こした違反の影響を受けない。
- 残高、nonce、カウンタ、Registry のバージョンは、操作の前後の差で確かめる。
- 手動承認の箇所（KYC、トラベルルール、開示）は管理者用の API を呼んで進める。
- `scene4-enforcement.test.ts` は、demo-tools 経由で未登録者の Deposit を Sepolia に送る。
- `mise run e2e` は `e2e/check-privacy.sql` も実行する。VASP 以外のスキーマに試験用の顧客名が保存されていないことを確認する。

`mise run e2e-fifo` は、5 送信者から同じ優先手数料で 100 件を送る。異なる優先手数料の拒否、ブロック内を含む取り込み順、監査結果を確かめる。Anvil では `APP_MODE=anvil` を指定する。専用の検証環境で実行する。実行中はほかの取引を止め、issuer、consortium-1〜3、relayer-a の鍵を使う操作を行わない。

起動済みの環境に合わせて実行する。

| モード | コマンド |
|---|---|
| Anvil | `APP_MODE=anvil mise run e2e` |
| DevNet | `mise run e2e` |
| DevNet HA | `APP_MODE=devnet-ha mise run e2e` |

Web を別ポートで起動した環境では `LEDGERA_WEB_URL` を指定する。RPC のポートを変更した場合は `LEDGERA_E2E_RPC_URL` を指定する。FIFO の検証で Gateway のポートを変更した場合は `LEDGERA_E2E_GATEWAY_URL` を指定する。

### 8.4 結合テストの設定

`mise run test-integration` は Docker で Anvil を起動し、RPC プロキシの読み取りと送信の拒否を確認する。
DB を使う結合テストには、テストごとに空の PostgreSQL データベースの接続 URL を設定する。未設定のテストはスキップされる。

| 対象 | 接続 URL の環境変数 |
|---|---|
| Gateway | `TEST_GATEWAY_DATABASE_URL` |
| VASP の KYC | `TEST_VASP_DATABASE_URL` |
| VASP の送金 | `TEST_VASP_TRANSFERS_DATABASE_URL` |
| Indexer の取り込み | `TEST_INDEXER_DATABASE_URL` |
| Indexer の失敗理由 | `TEST_INDEXER_FAILURES_DATABASE_URL` |
| Auditor の保存 | `TEST_AUDITOR_DATABASE_URL` |

監査の通し試験は、初期化直後の Anvil と空の DB を使う。設定は [07-indexer-auditor.md](07-indexer-auditor.md) の 3.8 節を参照する。デモを実行する前にこの試験を実行する。

## 9. 運用

### 9.1 費用（Sepolia ETH）

| 費用 | 頻度 |
|---|---|
| L1 へのデプロイ | 環境を作るたびに 1 回。公開 Sepolia の実測では fee scalar の設定を含めて 0.055029498826308127 ETH |
| Batch の投稿 | チェーンの稼働中。`BATCHER_MAX_CHANNEL_DURATION` を指定する |
| Deposit のデモ | 1 回あたり 0.001 ETH とガス代 |

公開 Sepolia の Batch 投稿費を 2026 年 11 月 24 日に計測した。

| 最大チャネル長（L1 ブロック） | 計測時間 | 投稿件数 | ガス代（Sepolia ETH） | 実際の投稿間隔（L1 ブロック） |
|---:|---:|---:|---:|---:|
| 25 | 60 分 | 14 | 0.009796432154048256 | 19〜20 |
| 5 | 8 分 | 38 | 0.001985552029823752 | 1〜2 |

計測時間は UTC の開始時刻と終了時刻の差。費用の集計範囲は、25 ブロック設定が L1 の 12,199,671〜12,199,955、5 ブロック設定が 12,199,957〜12,199,995。ガス代は投稿のレシートと Batcher の残高差で照合した。

実効ガス単価はどちらも約 1 gwei だった。投稿 1 件のガス使用量は 25 ブロック設定で 352,472〜1,804,568、5 ブロック設定で 22,744〜449,176 だった。

使わないときは `mise run app-down`、`mise run chain-down` の順に実行する。止めている間は Batch を投稿しない。

### 9.2 監視

`mise run status` はチェーン側サービスの状態、ブロック番号、運営側アカウントの残高を表示する。Gateway と Auditor の状態はそれぞれの API で確認する。

| 項目 | 取得元 | 異常の目安 |
|---|---|---|
| L2 のブロック高 | rpc-proxy の `eth_blockNumber` | 10 秒増えない |
| safe ブロック | rpc-proxy の `/rollup` 経由で `optimism_syncStatus` | unsafe との差が 30 分ぶん以上 |
| batcher の Sepolia 残高 | L1 | 0.05 ETH 未満 |
| Gateway の最新通番とコミット済み通番 | gateway の `/v1/status` | 差が開き続ける |
| Gateway のキュー | 同上 | 0 に戻らない |
| 運営側アカウントの L2 残高 | rpc-proxy の `eth_getBalance` | 0.1 ETH 未満 |
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
| 初期化の途中で失敗した | `mise run l2-bootstrap` をやり直す。済んだ手順は飛ばされる（02 章 5 節） |
| Gateway が `NONCE_GAP` を返す | Gateway を通さない送信で nonce がずれた。Gateway を再起動すると期待値を読み直す |
| safe ブロックが進まない | batcher の残高不足か、L1 の RPC の障害。`mise run chain-logs` で op-batcher を見る |
| 規則の有効化後に Registry を直したい | コンソーシアム画面から `RAW` の申請を出し、2 者の承認で実行する |
| ホストからの `cast send` が `-32601` で拒否される | ホストに出ている RPC は読み取り専用の rpc-proxy。取引は Gateway の `/rpc` に送る。op-reth に直接送る必要があるときは `mise run chain-shell` を使う |
| 外部者の直接送信が残高不足のエラーになる | 先に Deposit を行う。L2 残高が必要な残高（08 章 10.1 の表）に足りているかを外部者画面で確認する |
| 2 回目のデモで Lim さんへの送金が失敗する | 前の回の Lim さんは遮断済み。`mise run demo-seed` で新しい回を作る |
| 新しい申請が `PROPOSAL_IN_PROGRESS` で拒否される | 実行に失敗した申請か、取り下げ中の申請が残っている。再実行するか、2 人目が取り下げを完了する |
| 対照ノードのブロック高が進まない | 未登録アドレスの Deposit を含むブロックで分岐した後は進まない。`mise run control-down` で消す |
| op-reth のイメージのビルドが失敗する | fork の `superchain-registry` サブモジュールが取得できているか確認する |

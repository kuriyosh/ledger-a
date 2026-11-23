# 02 チェーン層

## 1. 構成

| コンポーネント | イメージ | 台数 | 備考 |
|---|---|---:|---|
| op-reth | `ledgera/op-reth:<短縮コミット>`（fork からビルド） | 1 | 冗長化構成では 3 |
| op-node | 公式 v1.20.2 | 1 | Sequencer。冗長化構成では 3 |
| op-batcher | 公式 v1.18.1 | 1 | calldata で投稿 |
| op-conductor | 公式 v0.9.6 | 0 | 冗長化構成では 3 |
| op-proposer、op-challenger | - | 0 | 動かさない |

公式イメージのレジストリは `us-docker.pkg.dev/oplabs-tools-artifacts/images/`。

`chain/versions.env` に次を持つ。

```
OP_NODE_IMAGE=us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.20.2
OP_BATCHER_IMAGE=us-docker.pkg.dev/oplabs-tools-artifacts/images/op-batcher:v1.18.1
OP_CONDUCTOR_IMAGE=us-docker.pkg.dev/oplabs-tools-artifacts/images/op-conductor:v0.9.6
OP_RETH_STOCK_IMAGE=us-docker.pkg.dev/oplabs-tools-artifacts/images/op-reth:v2.9.0
OP_DEPLOYER_VERSION=v0.9.0
OPTIMISM_UPSTREAM_TAG=op-reth/v2.9.0
OPTIMISM_FORK_REPO=https://github.com/kuriyosh/optimism.git
OPTIMISM_FORK_BRANCH=ledgera/op-reth-v2.9.0
OPTIMISM_FORK_COMMIT=<fork の 40 桁コミット>
OP_RETH_IMAGE=ledgera/op-reth:<短縮コミット>
FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:<固定するバージョン>
```

`FOUNDRY_IMAGE` は、op-reth に直接つなぐ作業（5 節の初期化、`make chain-shell`）をコンテナの中で行うために使う。

## 2. チェーンのパラメータ

| 項目 | 値 | 設定箇所 |
|---|---|---|
| L1 | Sepolia（chain ID 11155111） | - |
| L2 chain ID | 202610（`.env` の `L2_CHAIN_ID`） | op-deployer の `--l2-chain-ids` |
| L2 ブロック時間 | 2 秒 | intent の `deployOverrides.l2BlockTime` |
| ガス上限 | op-deployer の既定値 | 変更しない |
| EIP-1559 パラメータ | op-deployer の既定値 | 変更しない |
| L1 データ手数料 | 0 | intent の `gasPriceOracleBaseFeeScalar = 0`、`gasPriceOracleBlobBaseFeeScalar = 0` と、L1 の `SystemConfig.setGasConfigEcotone(0, 0)`（3.1 の手順 6） |
| operator fee | 0 | 既定値 |
| 最小 base fee | 0 | 既定値 |
| データ可用性 | calldata | op-batcher の `--data-availability-type=calldata` |
| ハードフォーク | genesis 時点で全て有効。後から有効化しない | op-deployer の既定 |

L2 chain ID は chainlist と衝突しないことを M0 で確認する。

## 3. L1 へのデプロイ

`chain/scripts/deploy-l1.sh` が手順 1〜6、`chain/scripts/gen-config.sh` が手順 7〜8 を行う。`gen-config.sh` は `chain/runtime/jwt.txt` も作る。公式サンプル `docs/public-docs/create-l2-rollup-example/scripts/setup-rollup.sh` を元にする。

### 3.1 手順

1. op-deployer v0.9.0 のバイナリを取得する。
2. `chain/scripts/derive-accounts.ts` で運営側アカウントのアドレスを得る。
3. 初期化する。

   ```
   op-deployer init \
     --l1-chain-id 11155111 \
     --l2-chain-ids "$L2_CHAIN_ID" \
     --workdir chain/.deployer \
     --intent-type standard-overrides
   ```

4. `chain/.deployer/intent.toml` を編集する（3.2）。
5. 適用する。

   ```
   DEPLOYER_PRIVATE_KEY="$ADMIN_PRIVATE_KEY" L1_RPC_URL="$L1_RPC_URL" \
     op-deployer apply --workdir chain/.deployer
   ```

6. L1 の `SystemConfig` の fee scalar を確認する。値が残っていれば admin が `setGasConfigEcotone(0, 0)` を実行する。アドレスは `chain/.deployer/state.json` の `opChainDeployments[0].SystemConfigProxy`。

7. 設定を取り出す。

   ```
   op-deployer inspect genesis --workdir chain/.deployer "$L2_CHAIN_ID" > chain/runtime/genesis.json
   op-deployer inspect rollup  --workdir chain/.deployer "$L2_CHAIN_ID" > chain/runtime/rollup.json
   ```

8. `chain/.deployer/state.json` から L1 コントラクトのアドレスを読み、`deployments/devnet.json` の `l1` に書く。使うのは `opChainDeployments[0].OptimismPortalProxy` と `SystemConfigProxy`。

### 3.2 intent.toml の編集

`op-deployer init` が書いた値のうち、次のキーだけを書き換える。`opcmAddress` と 2 つの `*ContractsLocator` は変えない。

| キー | 値 |
|---|---|
| `fundDevAccounts` | `true` |
| `chains[0].baseFeeVaultRecipient` | admin |
| `chains[0].l1FeeVaultRecipient` | admin |
| `chains[0].sequencerFeeVaultRecipient` | admin |
| `chains[0].operatorFeeVaultRecipient` | admin |
| `chains[0].roles.l1ProxyAdminOwner` | admin |
| `chains[0].roles.l2ProxyAdminOwner` | admin |
| `chains[0].roles.systemConfigOwner` | admin |
| `chains[0].roles.unsafeBlockSigner` | sequencer |
| `chains[0].roles.batcher` | batcher |
| `chains[0].roles.proposer` | proposer |
| `chains[0].roles.challenger` | challenger |
| `chains[0].deployOverrides.l2BlockTime` | `2` |
| `chains[0].deployOverrides.gasPriceOracleBaseFeeScalar` | `0` |
| `chains[0].deployOverrides.gasPriceOracleBlobBaseFeeScalar` | `0` |

- `l1ProxyAdminOwner` と `l2ProxyAdminOwner` は既定値がない。未設定だと op-deployer がエラーにする。
- `l2ProxyAdminOwner` は L2 の `ProxyAdmin`（`0x4200000000000000000000000000000000000018`）の所有者になる。Registry を predeploy に配置するのに使う。
- `fundDevAccounts = true` は Anvil の既定アカウント 30 個に L2 の genesis で残高を与える。初期化（5 節）の原資にする。これらの鍵は公開されているが、規則の有効化後は未登録なので取引できない。

fee scalar を 2 か所で 0 にする理由。

- `deployOverrides` の 2 項目が効くのは、L2 の genesis と `rollup.json` の初期値だけ。
- L1 の `SystemConfig` は、op-deployer v0.9.0 が標準値（base fee scalar 1368、blob base fee scalar 801949）で初期化する。`deployOverrides` では変わらない。
- L2 は `SystemConfig` の更新イベントに追従する。L1 側が標準値のままだと、L1 と L2 の設定が食い違う。手順 6 で L1 側も 0 にして揃える。
- L2 で 0 になっていることは初期化のときに確認する（5 節、V19）。

## 4. 起動

`chain/compose/docker-compose.chain.yml` に op-reth、op-node、op-batcher、rpc-proxy の 4 サービスを書く。公式サンプルの `docker-compose.yml` からの差分は次のとおり。

- op-reth のイメージを `${OP_RETH_STOCK_IMAGE}` にする。`OP_RETH_IMAGE` を指定した場合はそのイメージを使う。
- proposer、challenger、dispute-mon を削る。
- 各コンポーネントに、役割に対応する鍵を渡す（公式サンプルは全部に同じ鍵を渡している）。
- op-reth と op-node のポートをホストに出さない。ホストに出すのは rpc-proxy だけ（[10-dev-ops.md](10-dev-ops.md) の 7 節）。

### 4.1 op-reth

```
node
--chain=/workspace/genesis.json
--datadir=/workspace/op-reth-data
--http --http.addr=0.0.0.0 --http.port=8545
--http.api=debug,eth,net,txpool,web3
--ws --ws.addr=0.0.0.0 --ws.port=8546
--ws.api=debug,eth,net,txpool,web3
--authrpc.addr=0.0.0.0 --authrpc.port=8551
--authrpc.jwtsecret=/workspace/jwt.txt
--rollup.disable-tx-pool-gossip
--builder.deadline=2
--builder.interval=100ms
```

- `debug` は Indexer が失敗理由を取るのに使う（07 章）。
- `--rollup.disable-tx-pool-gossip` は必須。取引を RPC だけで受け付けるようにする。
- HTTP と WS は `ledgera-chain` ネットワークの中だけで待ち受ける。取引を送れるのは、このネットワークに入っている Gateway と demo-tools だけ。

### 4.2 op-node

```
op-node
--l1=${L1_RPC_URL}
--l1.beacon=${L1_BEACON_URL}
--l2=http://op-reth:8551
--l2.jwt-secret=/workspace/jwt.txt
--l2.enginekind=reth
--rollup.config=/workspace/rollup.json
--sequencer.enabled=true
--sequencer.stopped=false
--verifier.l1-confs=4
--p2p.disable
--rpc.addr=0.0.0.0 --rpc.port=8547
--rpc.enable-admin
```

### 4.3 op-batcher

環境変数。

```
OP_BATCHER_L1_ETH_RPC=${L1_RPC_URL}
OP_BATCHER_L2_ETH_RPC=http://op-reth:8545
OP_BATCHER_ROLLUP_RPC=http://op-node:8547
OP_BATCHER_PRIVATE_KEY=${BATCHER_PRIVATE_KEY}
OP_BATCHER_POLL_INTERVAL=1s
OP_BATCHER_SUB_SAFETY_MARGIN=6
OP_BATCHER_NUM_CONFIRMATIONS=1
OP_BATCHER_SAFE_ABORT_NONCE_TOO_LOW_COUNT=3
```

引数。

```
op-batcher
--rpc.addr=0.0.0.0 --rpc.port=8548 --rpc.enable-admin
--max-channel-duration=${BATCHER_MAX_CHANNEL_DURATION}
--data-availability-type=calldata
--throttle.unsafe-da-bytes-lower-threshold=0
--resubmission-timeout=30s
```

- `BATCHER_MAX_CHANNEL_DURATION` は L1 ブロック数。既定は 25（約 5 分）。デモ中は 5（約 1 分）にする。値が小さいほど Sepolia ETH を多く使う。
- op-batcher の DA スロットリングは無効にする。op-reth の RPC で `miner` 名前空間を公開しないため。
- op-batcher は op-node から取得した rollup 設定の `batch_inbox_address` を使う。

### 4.4 Sepolia への接続

- `L1_RPC_URL` は API キー付きのプロバイダを使う。公開エンドポイントは op-node の取得頻度で制限にかかることがある。
- `L1_BEACON_URL` は公式サンプルと同じ `https://ethereum-sepolia-beacon-api.publicnode.com` を既定にする。

## 5. L2 の初期化

`chain/scripts/bootstrap-l2.sh`（`make l2-bootstrap`）が行う。この時点では規則が無効なので、Gateway を通さない。op-reth の RPC はホストに出していないので、`ledgera-chain` ネットワークにつないだ Foundry コンテナ（`FOUNDRY_IMAGE`）の中で実行する。

1. L2 の `GasPriceOracle`（`0x420000000000000000000000000000000000000F`）の `baseFeeScalar()` と `blobBaseFeeScalar()` が 0 を返すまで待つ。
2. `contracts/script/Bootstrap.s.sol` を op-reth の RPC に対して `--broadcast` で実行する（下の表の手順 1〜13）。
3. スクリプトが出力したアドレスと、L2 のイベントから有効化と権限移譲のブロック番号を読む。
4. 手順 2 の取引を 1 つ選び、`eth_getTransactionReceipt` の `l1Fee` が 0 であることを確認する。
5. 開発用アカウント 1 を送信元に、読み取り用の rpc-proxy（`127.0.0.1:8545`）経由で op-reth の `eth_estimateGas` を呼ぶ。`ledgera: sender not allowed` が返ることを確認する。
6. `deployments/devnet.json` の `contracts`、`enforcementBlock`、`auditStartBlock` を書く。`l1` は `gen-config.sh` が書いた値を残す。

やり直しができるように、`Bootstrap.s.sol` は次の作りにする。

- コントラクトは CREATE2（固定の salt）でデプロイする。アドレスが毎回同じになる。
- 各手順は先に現在の状態を読む。済んでいれば飛ばす。判定はコードの有無、`getVasp`、`getAccount`、`balanceOf`、`allowance`、`enforcementEnabled`、`consortium`、`owner` で行う。
- 規則の有効化後は、既存のアドレスだけを使う。Safe の所有者としきい値、権限の移譲先、トークンの設定を確認してから記録する。

| 順 | 送信者 | 操作 |
|---:|---|---|
| 1 | 開発用アカウント 0 | L2 で送信する運営側アカウント（01 章 5.2）に 1 ETH ずつ送る |
| 2 | admin | `KycRegistry` の実装をデプロイする |
| 3 | admin | `ProxyAdmin.upgradeAndCall(0x42…0700, 実装, initialize(admin))` を呼ぶ |
| 4 | admin | `ConsortiumSafe`（所有者 3、しきい値 2）をデプロイして `setup` する |
| 5 | admin | `LedgerForwarder`、`TravelRuleCompliance`、`LedgerToken` × 2、`AtomicSwap`、`ReceiptLog`、`DepositProbe` をデプロイする。`LedgerForwarder` には Registry のアドレスを渡す。所有者を持つコントラクトのうち `ReceiptLog` 以外は、所有者をいったん admin にする。続けて `bindToken`、`setSupportedToken`、`addAgent(issuer)` を呼び、`transferOwnership` で 03 章 1 節の表の所有者に移す。`ReceiptLog` には gateway のアドレスと所有者（`ConsortiumSafe`）をコンストラクタで渡す |
| 6 | admin | `registerVasp` で VASP 0、1、2 を登録する。管理者（admin、vasp-a-admin、vasp-b-admin）は同時に登録される |
| 7 | admin | `registerOperatorAccount` で gateway、issuer、consortium-1〜3、relayer-a、relayer-b を登録する |
| 8 | vasp-b-admin | `registerAccount` で vasp-b-treasury を `VASP_TREASURY` として登録する |
| 9 | issuer | vasp-b-treasury に tUSD 1,000,000 と tJPY 200,000,000 を Mint する |
| 10 | relayer-b | vasp-b-treasury が署名した `approve(AtomicSwap, 上限)` を 2 トークン分、`LedgerForwarder` 経由で送る |
| 11 | admin | `enableEnforcement()` を呼ぶ |
| 12 | admin | `transferConsortium(ConsortiumSafe)` を呼ぶ |
| 13 | admin | `ProxyAdmin.transferOwnership(ConsortiumSafe)` を呼ぶ |

`enforcementBlock` は手順 11 のブロック番号。`auditStartBlock` は DevNet では手順 13、Anvil では手順 12 の次のブロック番号。

手順 6 の引数。

| `vaspId` | `admin` | `travelRuleSigner` | `name` | `endpoint` |
|---:|---|---|---|---|
| 0 | admin | admin | `ledgerA Network` | 空文字 |
| 1 | vasp-a-admin | vasp-a-signer | `VASP A` | `http://vasp-a:8621` |
| 2 | vasp-b-admin | vasp-b-signer | `VASP B` | `http://vasp-b:8622` |

`endpoint` は Compose 内の名前。手順 10 の `approve` の量は `type(uint256).max`。

- 手順 3 の時点で `0x42…0700` には OP Stack の `Proxy` が入っている。管理者は `ProxyAdmin`、実装は未設定。genesis が predeploy 名前空間の 2048 アドレスすべてに `Proxy` を置くため。
- 手順 3 が済んでいるかは、`0x42…0700` の ERC-1967 の実装スロットで判定する。
- 手順 12 と 13 は規則の有効化後だが、Gateway を通さずに送る。Gateway はこの時点でまだ起動していない。
- 監査ツールは `auditStartBlock` 以降のブロックだけを対象にする。これ以降の取引はすべて Gateway を通す。

## 6. KYC 規則（要件 9）

### 6.1 規則

**取引の送信者が Registry で有効でなければ、その取引は実行されない。**

判定は次の手順。入力は送信者アドレス `sender`、取引種別、ブロックの `timestamp`。

1. `sender` が免除アドレスなら許可する。
2. Registry の `flags` の最下位ビットが 0 なら許可する（規則が無効）。
3. 取引種別が EIP-7702（0x04）なら拒否する。
4. `accounts[sender]` を読む。`status` が `ACTIVE`（1）でなければ拒否する。
5. `validUntil` が 0 でなく、`timestamp > validUntil` なら拒否する。
6. `vasps[vaspId]` を読む。`status` が `ACTIVE`（1）でなければ拒否する。
7. 許可する。

免除アドレス。

| アドレス | 理由 |
|---|---|
| `0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001` | 各ブロック先頭の L1 属性取引の送信者 |
| `0x0000000000000000000000000000000000000000` | `eth_call` で `from` を省略したときの呼び出し元。署名も Deposit もできないので安全 |

PostExec 種別の取引は、ビルダーが合成するシステム取引として検査から外す。指定した OP のハードフォークは genesis から有効にする。

`eth_call` と `eth_estimateGas` は実行時の判定を使う。`from` を省略するとゼロアドレスになる。未登録の `from` を指定した場合は `ledgera: sender not allowed` が返る。

拒否したときの結果。

| 取引の種類 | 結果 |
|---|---|
| 通常の取引（種別 0、1、2） | 取引は無効。ブロックに入らない。入れたブロックは他のノードが無効と判定する |
| EIP-7702 取引（種別 4） | 同上 |
| Deposit 取引（種別 0x7E） | ブロックに入る。失敗 Deposit になる。状態変更は巻き戻る。nonce は 1 増える。mint された ETH は残る。レシートは失敗 |

検査しないもの。

- 取引の宛先（`to`）。
- 取引の途中で呼ばれるコントラクトと、ETH の送り先。
- コントラクトのデプロイ可否。登録済みの送信者はデプロイできる。

### 6.2 Registry のストレージ配置

実行層は Registry のストレージを直接読む。配置は 03 章 2.3 で定義する。実行層が読むのは `accounts[a]`、`vasps[id]`、`flags` の 3 か所。基準スロット `B` はスロットの計算に使う。

| 名前 | スロット |
|---|---|
| 基準スロット `B` | `0x8fe41602647df745ca7420aedc6edbf55eb356a7ee29e0fe07118b9b158f2e00` |
| `accounts[a]` | `keccak256(pad32(a) ‖ B)` |
| `vasps[id]` | `keccak256(pad32(id) ‖ (B + 1))` |
| `flags` | `B + 2` |

`B` は ERC-7201 の式で名前空間 `ledgera.storage.KycRegistry` から求めた値。

ワードの読み方。

| ワード | ビット | 意味 |
|---|---|---|
| `accounts[a]` | 0〜7 | `status` |
| | 8〜15 | `kind` |
| | 16〜47 | `vaspId` |
| | 48〜111 | `validUntil`（UNIX 秒） |
| `vasps[id]` | 0〜7 | `status` |
| `flags` | 0 | 規則の有効フラグ |

テストベクタ（Rust と Solidity の両方のテストで確認する）。

| 入力 | スロット |
|---|---|
| `accounts[0x1111111111111111111111111111111111111111]` | `0x0af8647d1a0890445823b07eb9e2efa4337166e6e4bd9cee280b017e0ec9696e` |
| `vasps[1]` | `0x5ef4ef46b66bf28de20f56d7769e17bd4003ba8f75d884139649b0c9bc4ca857` |

### 6.3 実装（op-revm）

fork の `rust/op-revm` を変更する。

| ファイル | 変更 |
|---|---|
| `src/ledgera.rs`（新規） | 定数、スロット計算、判定関数 `sender_allowed` |
| `src/lib.rs` | `pub mod ledgera;` を追加する |
| `src/transaction/error.rs` | `OpTransactionError::SenderNotAllowed` を追加する。表示は `ledgera: sender not allowed` |
| `src/handler.rs` | `validate_against_state_and_deduct_caller` の先頭で `sender_allowed` を呼ぶ |

判定関数の概形。型と import は fork の該当バージョンに合わせる。

```rust
pub const KYC_REGISTRY: Address = address!("0x4200000000000000000000000000000000000700");
pub const L1_ATTRIBUTES_DEPOSITOR: Address = address!("0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001");
const BASE_SLOT: U256 =
    uint!(0x8fe41602647df745ca7420aedc6edbf55eb356a7ee29e0fe07118b9b158f2e00_U256);

pub fn account_slot(a: Address) -> U256 {
    mapping_slot(B256::left_padding_from(a.as_slice()), BASE_SLOT)
}
pub fn vasp_slot(id: u32) -> U256 {
    mapping_slot(B256::from(U256::from(id)), BASE_SLOT + U256::from(1))
}
pub fn flags_slot() -> U256 {
    BASE_SLOT + U256::from(2)
}

pub fn sender_allowed<DB: Database>(
    db: &mut DB,
    sender: Address,
    tx_type: u8,
    timestamp: u64,
) -> Result<bool, DB::Error> {
    if sender == Address::ZERO || sender == L1_ATTRIBUTES_DEPOSITOR || tx_type == POST_EXEC_TX_TYPE_ID {
        return Ok(true);
    }
    let _ = db.basic(KYC_REGISTRY)?;
    if db.storage(KYC_REGISTRY, flags_slot())? & U256::from(1) == U256::ZERO {
        return Ok(true);
    }
    if tx_type == EIP7702_TX_TYPE {
        return Ok(false);
    }
    let acct = db.storage(KYC_REGISTRY, account_slot(sender))?;
    if low_u8(acct) != STATUS_ACTIVE {
        return Ok(false);
    }
    let valid_until = bits_u64(acct, 48);
    if valid_until != 0 && timestamp > valid_until {
        return Ok(false);
    }
    let vasp = db.storage(KYC_REGISTRY, vasp_slot(bits_u32(acct, 16)))?;
    Ok(low_u8(vasp) == STATUS_ACTIVE)
}
```

ハンドラへの差し込みの概形。

```rust
fn validate_against_state_and_deduct_caller(/* 既存の引数 */) -> Result<(), Self::Error> {
    let (block, tx, cfg, journal, chain, _) = evm.ctx().all_mut();
    let spec = cfg.spec();

    if !ledgera::sender_allowed(journal.db_mut(), tx.caller(), tx.tx_type(), block_timestamp(block))? {
        return Err(OpTransactionError::SenderNotAllowed.into());
    }

    if tx.tx_type() == DEPOSIT_TRANSACTION_TYPE {
        // 既存の処理
```

この位置に置く理由。

- Deposit の分岐より前なので、Deposit にも通常の取引にも適用される。
- エラーは取引の無効エラー（`EVMError::Transaction`）になる。既存の `catch_error` が種別で振り分ける。
  - Deposit は `catch_error_failed_deposit` に入る。nonce の加算、mint の反映、失敗レシートは既存の処理が行う。
  - それ以外は `discard_and_surface_error` に入る。ペイロードビルダーは取引を飛ばし、検証側はブロックを無効にする。
- ストレージは `journal.db_mut()` から読む。同じ関数内の `L1BlockInfo::try_fetch` と同じ読み方で、アクセスリストの warm 状態を変えない。

確認が要る点は [12-open-issues.md](12-open-issues.md) の V2、V3、V13。

### 6.4 実装（プール検査）

op-reth のプールに入る時点でも同じ判定を行う。合意には関与しない。目的は直接送信された取引にすぐエラーを返すこと。

| ファイル | 変更 |
|---|---|
| `rust/op-reth/crates/node/src/ledgera.rs`（新規） | `KycValidatorWrapper` と `KycValidator` |
| `rust/op-reth/crates/node/src/node.rs` | `OpNode::components()` のプール構築に `.with_validator_wrapper(KycValidatorWrapper)` を追加する。型エイリアス `OpNodeComponentBuilder` の検証ラッパー型を合わせる |

- 判定は `OpValidatorWrapper` トレイトで差し込む。`wrap(self, validator, provider)` で元の検証器と状態プロバイダを受け取る。
- 実装例は fork 内の `rust/op-reth/crates/node/tests/it/custom_pool/validator.rs`。
- `KycValidator` は内側の検証が `Valid` を返したときだけ判定する。
- このため、標準の検証（nonce、残高、手数料）で落ちる取引には、規則のエラーが返らない。規則による拒否を確かめる取引は、標準の検証を通る残高と手数料で送る（08 章 10.1）。
- 規則は最新のヘッドの状態と時刻で判定する。スロット計算と判定は `op_revm::ledgera` を使う。
- 受付後に送信者が停止、遮断、期限切れになった場合も、ブロックを作るときに再検査する。拒否された取引が一時的にプールに残る場合がある。
- 拒否は `InvalidPoolTransactionError::Other` で返す。メッセージは `ledgera: sender not allowed: <アドレス>`。
- Gateway と demo-tools は、エラーメッセージに `ledgera: sender not allowed` が含まれるかで判定する。この文字列は変えない。

型エイリアスの変更が通らない場合は、`rust/op-reth/crates/txpool` の `OpTransactionValidator` に判定を直接書く（V4）。

### 6.5 テスト

fork リポジトリ内に書く。

| 対象 | 内容 |
|---|---|
| `op-revm` 単体 | スロット計算が 6.2 のテストベクタと一致する |
| | 判定表: 規則無効、免除アドレス、未登録、`SUSPENDED`、`BLOCKED`、期限切れ、VASP 停止、EIP-7702、正常 |
| | 未登録の通常取引が `SenderNotAllowed` を返し、状態が変わらない |
| | 未登録の Deposit が `FailedDeposit` になり、nonce が 1 増え、mint が残る |
| | 宛先が登録状態を見ないコントラクト（カウンタ）の Deposit で比べる。未登録の送信者ではカウンタが増えない。同じ `to`、`data`、`gasLimit` を登録済みの送信者が送ると増える |
| | 同じブロック内で登録された直後の取引が通る |
| `op-reth` 結合 | プールが未登録の送信者を拒否し、メッセージが規定の文字列を含む |
| | 残高、`gas`、`maxFeePerGas` が同じ取引を、登録済みと未登録の送信者から送る。登録済みは受理され、未登録は規定の文字列で拒否される |
| | 残高が `gas × maxFeePerGas` に足りない未登録の送信者には、標準の残高不足のエラーが返る。規定の文字列は返らない |
| | プール検査を外した構成で、ペイロードが未登録の取引を含まない |

DevNet 上の確認は検証ノード（10 節）と E2E（[10-dev-ops.md](10-dev-ops.md)）で行う。

## 7. 到着順の処理（要件 16）

### 7.1 規則

取引を受け付けるのは Gateway。Gateway が振った通番の順に、L2 のブロックに取引が並ぶ。

実行層の順序付けは改造しない。次の条件を揃えることで、op-reth の既定の順序付けが到着順と一致する。

| 条件 | 担保する場所 |
|---|---|
| 取引を受け付けるのは Gateway だけ | op-reth の RPC をホストに出さない。サービスとホストには、読み取り専用の rpc-proxy だけを見せる（10 章 7 節）。取引の gossip を切る |
| Gateway は通番順に 1 件ずつ転送し、応答を待ってから次を送る | Gateway |
| すべての取引の priority fee が同じ | Gateway が `maxPriorityFeePerGas == 1 wei` 以外を拒否する |
| 受け付けた取引はプールですぐ実行可能になる | Gateway が nonce の連続、`maxFeePerGas`、残高を事前に検査する |

- op-reth のプールは、実効 priority fee が同じ取引を、実行可能になった順（`submission_id` の小さい順）に並べる。
- priority fee を 0 ではなく 1 wei にする理由。op-reth はブロックの構築中にペイロードを何度か作り直し、手数料の合計が増えたものだけを採用する。0 だと、取引を追加して作り直しても合計が変わらず、作り直したペイロードが捨てられる。その場合、スロットの途中で届いた取引は次のブロックに回る。
- op-reth に直接つながるのは Gateway と demo-tools。demo-tools が直接送るのは、場面 4 の外部者（未登録）の取引だけ。ブロックに入らないので、順序に影響しない。

### 7.2 通番どおりに並ばない場合

次の場合は、通番の順とブロック内の順が一致しない。扱いは監査ツールと揃える（07 章 3.2）。

| 場合 | 挙動 | 監査での扱い |
|---|---|---|
| Deposit 取引 | ブロックの先頭に入る。通番を持たない | 検査の対象外 |
| 実行時に無効になった取引（送信者の停止、残高不足） | ブロックに入らない | 監査ツールが L2 の状態で理由を確認できれば「正当な除外」。確認できなければ違反（C5） |
| ブロックのガス上限に収まらない取引 | 飛ばされ、後続が先に入ることがある | 違反（C4）。例外にしない |

- 3 つめは DevNet の取引量では起きない。ブロックのガス上限は 60,000,000（op-deployer の既定値）。1 取引の上限は `GAS_LIMIT_CAP`（5,000,000）。
- 3 つめを起こさないようにするには、7.3 の強化を入れる。

### 7.3 任意の強化

M7 までに余力があれば行う。必須ではない。

- プールの順序付けを到着順に固定する。`OpPoolBuilder::with_ordering` に、優先度が常に同じ `TransactionOrdering` を渡す。実装例は `rust/op-reth/crates/node/tests/it/custom_pool/ordering.rs`。
- ガス上限に収まらない取引で構築を止める。`OpPayloadBuilder::with_transactions` に渡すイテレータで、`mark_invalid` の後は `None` を返す。

## 8. 手数料（要件 22）

- 利用者はガス代を払わない。利用者のアドレスは ETH を持たない。
- L2 取引を送るのは運営側アカウントだけ。初期化で 1 ETH ずつ持つ。
- 1 取引の費用は `gas × (base fee + 1 wei)`。base fee は数 wei まで下がる。
- L1 への Batch 投稿費は batcher が Sepolia ETH で払う。

## 9. L1 経由の取引

### 9.1 Deposit

- L1 の `OptimismPortal.depositTransaction(to, value, gasLimit, isCreation, data)` を呼ぶと、L2 に Deposit 取引が入る。
- 送信者が EOA なら、L2 の送信者は同じアドレス。コントラクトなら別名アドレスになる。
- Sequencer は L1 の確認を待ってから取り込む。Sepolia では 1〜2 分かかる。

未登録アドレスの Deposit（デモ場面 4）。

1. attacker が Sepolia で `depositTransaction` を呼ぶ。`msg.value` を付け、`to` に `DepositProbe`、`data` に `poke()` を入れる。
2. L2 に Deposit 取引が入る。規則により失敗 Deposit になる。
3. `poke()` は実行されない。`DepositProbe.count(attacker)` は増えない。attacker の L2 残高は mint 分だけ増える。
4. attacker はその ETH を動かせない。送信者として拒否されるため。

宛先を `DepositProbe` にする理由。

- `DepositProbe` は登録状態を見ない（03 章 9 節）。標準の実行層では、同じ Deposit が成功してカウンタが増える。
- 宛先をトークンにすると、標準の実行層でもトークンの検査で失敗する。レシート、mint、nonce、残高の結果が同じになり、実行層の規則が効いた証拠にならない。
- 標準の実行層との比較は対照ノードで行う（10.2）。

### 9.2 標準ブリッジ

- `L1StandardBridge` と `L1CrossDomainMessenger` 経由の入金は、規則の有効化後は失敗する。L2 側の送信者が Messenger の別名アドレスで、未登録のため。
- Messenger の別名アドレスは登録しない。登録すると、未登録の L1 利用者が L2 の任意の呼び出しを起動できる。
- 運営側アカウントが ETH を追加で持ち込むときは、そのアカウント自身が `depositTransaction` を呼ぶ。

## 10. 検証ノードと対照ノード（要件 9、26）

`chain/compose/docker-compose.replica.yml` に書く。どちらも Sequencer とは P2P でつながない。L1 の Batch だけからブロックを導出する。

### 10.1 検証ノード

「どのノードが再実行しても同じ判定になる」ことを確認する構成。

| サービス | 内容 |
|---|---|
| op-reth-replica | fork のイメージ。別のデータディレクトリ |
| op-node-replica | `--sequencer.enabled=false`、`--p2p.disable` |

確認方法。

- `chain/scripts/compare-heads.sh` が Sequencer の safe ブロックと検証ノードの同じ高さのブロックのハッシュを比べる。
- 未登録アドレスの Deposit を含むブロックで一致すれば、失敗 Deposit の判定が再現されている。

### 10.2 対照ノード

「同じ Deposit が、標準の実行層では成功する」ことを確認する構成。Deposit が失敗した原因が実行層の規則であることを示す。Compose のプロファイル `control` に入れ、`make control-up` で起動する。

| サービス | 内容 |
|---|---|
| op-reth-control | 公式イメージ（`OP_RETH_STOCK_IMAGE`）。別のデータディレクトリ |
| op-node-control | op-node-replica と同じ設定 |

確認方法。`chain/scripts/compare-deposit.sh <L2 の取引ハッシュ>`（`make control-compare DEPOSIT_HASH=<L2 の取引ハッシュ>`）が、未登録アドレスの Deposit（9.1）の結果を 3 つのノードから読んで並べる。期待する結果は次のとおり。

| ノード | 実行層 | レシート | `DepositProbe.count(attacker)` |
|---|---|---|---:|
| Sequencer | 改造版 | 失敗 | 0 |
| 検証ノード | 改造版 | 失敗 | 0 |
| 対照ノード | 標準 | 成功 | 1 |

- 3 つのノードは、L1 の同じ Deposit を取り込む。違うのは実行層だけ。
- 規則の有効化より前のブロックと、未登録アドレスの Deposit を含まないブロックは、標準の実行層でも同じ結果になる。対照ノードはそこまで Sequencer と一致する。
- 対照ノードは、未登録アドレスの Deposit を含むブロックで分岐する。比較スクリプトは、3 台の親ブロックのハッシュも照合する。
- 対照ノードで確認できるのは、そのチェーンで最初の未登録 Deposit だけ。確認が済んだら `make control-down` でデータごと消す。
- 対照ノードが期待どおりに導出するかは M2 で確かめる（V20）。

## 11. 冗長化（要件 19）

設定は `chain/compose/docker-compose.ha.yml` にある。

### 11.1 構成

| 組 | サービス |
|---|---|
| 1 | op-reth-1、op-node-1、op-conductor-1 |
| 2 | op-reth-2、op-node-2、op-conductor-2 |
| 3 | op-reth-3、op-node-3、op-conductor-3 |

- 3 つの op-conductor が Raft でリーダーを 1 つ選ぶ。リーダーの op-node だけがブロックを作る。
- 1 台の停止に耐える。BFT ではない。3 台とも同じ運営者が動かす前提。
- op-batcher は 1 台。3 つの op-node と op-reth を接続先に持ち、リーダーに追従する。

### 11.2 設定

op-node に追加する引数。

```
--conductor.enabled=true
--conductor.rpc=http://op-conductor-N:8547
--sequencer.stopped=true
--p2p.sequencer.key=${SEQUENCER_PRIVATE_KEY}
```

- `--p2p.disable` を外す。3 台を静的ピアでつなぎ、unsafe ブロックを伝える。
- `SEQUENCER_PRIVATE_KEY` は 3 台で同じ鍵（`unsafeBlockSigner`）。

op-conductor の環境変数。

```
OP_CONDUCTOR_NODE_RPC=http://op-node-N:8547
OP_CONDUCTOR_ROLLUP_CONFIG=/workspace/rollup.json
OP_CONDUCTOR_EXECUTION_RPC=http://op-reth-N:8545
OP_CONDUCTOR_CONSENSUS_ADDR=0.0.0.0
OP_CONDUCTOR_CONSENSUS_PORT=50050
OP_CONDUCTOR_CONSENSUS_ADVERTISED=op-conductor-N:50050
OP_CONDUCTOR_RAFT_SERVER_ID=sequencer-N
OP_CONDUCTOR_RAFT_STORAGE_DIR=/data/raft
OP_CONDUCTOR_RAFT_BOOTSTRAP=true    # 1 台目だけ
OP_CONDUCTOR_HEALTHCHECK_INTERVAL=1
OP_CONDUCTOR_HEALTHCHECK_UNSAFE_INTERVAL=6
OP_CONDUCTOR_HEALTHCHECK_MIN_PEER_COUNT=1
OP_CONDUCTOR_RPC_ADDR=0.0.0.0
OP_CONDUCTOR_RPC_PORT=8547
OP_CONDUCTOR_PAUSED=true            # 起動時
```

必須の項目。v0.9.6 は次の 9 項目が明示されていないと起動しない。既定値がある項目も省略できない。

| 項目 | 値 | 補足 |
|---|---|---|
| `NODE_RPC` | 同じ組の op-node | |
| `EXECUTION_RPC` | 同じ組の op-reth | |
| `CONSENSUS_ADDR` | `0.0.0.0` | Raft の待受アドレス。既定は `127.0.0.1` で、ほかのコンテナから届かない |
| `CONSENSUS_PORT` | 50050 | |
| `RAFT_SERVER_ID` | `sequencer-N` | 3 台で重複させない |
| `RAFT_STORAGE_DIR` | `/data/raft` | ボリュームに置く |
| `HEALTHCHECK_INTERVAL` | 1 | 単位は秒 |
| `HEALTHCHECK_UNSAFE_INTERVAL` | 6 | 単位は秒。最新の unsafe ブロックの時刻と現在の差の上限。ブロック時間（2 秒）の 3 倍にしている |
| `HEALTHCHECK_MIN_PEER_COUNT` | 1 | op-node の P2P ピア数の下限 |

必須ではないが明示する項目。

- `CONSENSUS_ADVERTISED`: ほかの組に知らせる Raft のアドレス。省略すると待受アドレス（`0.0.0.0`）を知らせてしまう。Compose のサービス名とポートを入れる。
- `RPC_ADDR`、`RPC_PORT`: op-conductor の RPC の既定ポートは 8545。op-node の `--conductor.rpc` と Gateway の `CONDUCTOR_RPC_URLS` は 8547 を指すので、8547 を明示する。

`HEALTHCHECK_MIN_PEER_COUNT` を 1 にする理由。3 台構成で 1 台が止まると、残った op-node のピアは 1 つになる。2 以上にすると、残った 2 台も不健全と判定され、切り替わらない。

初回は L1 を配備し、genesis と 資金を入れたアカウントを用意する。単一 Sequencer が動いている場合は `make chain-down` で停止する。

```bash
make ha-up
make l2-bootstrap-ha
make app-up APP_MODE=devnet-ha
```

`make ha-up` は静的ピア用の鍵を生成する。各 Conductor に rollup 設定を渡し、Raft に 3 台を登録する。初回は選出されたリーダーが最初の unsafe ブロックを作る。Conductor が制御を再開してから Batcher を起動する。op-reth は内部 IPC で同期ピアを登録し、最新ブロックをディスクに保存する。

停止は `make app-down APP_MODE=devnet-ha` と `make ha-down` を使う。各ノードのデータと P2P 鍵を再利用する。

### 11.3 Gateway の切替

op-conductor は未処理の取引を引き継がない。Gateway が再送する。

- Gateway は 3 台の Conductor のリーダー、稼働、ヘルスを確認する。過半数に到達し、健康なリーダーが 1 台のとき、その op-reth に転送する。
- リーダーが変わったら、転送済みでブロックに入っていない取引を通番順に新しいリーダーへ送り直す。
- 通番と Receipt は Gateway の DB にあるので、切替で失われない。

詳細は [04-gateway.md](04-gateway.md) の 7 節。

ほかのサービスの読み取りは rpc-proxy を通る。rpc-proxy は 3 台のうち、ブロック高が最も高い組に転送する（10 章 7 節）。止まった組を避けて読む。

### 11.4 障害試験（デモ場面 7）

| 試験 | 期待 |
|---|---|
| リーダーの組の op-node と op-reth を止める（`make ha-kill-leader`） | 30 秒以内に別の組がブロックを作り始める |
| 切替中に送金する | 切替後にブロックに入る。通番が連続している |
| 止めた組を戻す | フォロワーとして追いつく。リーダーが 2 つにならない |
| 切替の前後で監査ツールを実行する | 順序違反と未採用が出ない |

## 12. fork の運用

### 12.1 ブランチ

- fork: `kuriyosh/optimism`。
- ブランチ: `ledgera/op-reth-v2.9.0`。上流の tag `op-reth/v2.9.0` から切る。
- 変更は 6.3、6.4、6.5 のファイルだけにする。
- 上流の更新は取り込まない。取り込むときは、新しい tag から新しいブランチを切り、変更を移す。

### 12.2 開発

```
cd rust
cargo test -p op-revm ledgera
cargo test -p reth-optimism-node ledgera
just build-op-reth
```

Rust のバージョンは fork の `rust/rust-toolchain.toml` に従う。

### 12.3 イメージのビルド

`chain/scripts/build-op-reth.sh` が行う。

1. `OPTIMISM_FORK_COMMIT` を浅く取得する。サブモジュール `superchain-registry` も取得する。
2. 上流の Dockerfile でビルドする。

   ```
   docker buildx build \
     -f rust/op-reth/DockerfileOp \
     --build-context superchain-registry=./superchain-registry \
     --build-arg BUILD_PROFILE=release \
     -t "$OP_RETH_IMAGE" \
     rust
   ```

3. `OP_RETH_IMAGE` を `chain/versions.env` に書く。

- ビルドコンテキストは `rust/`。`superchain-registry` は名前付きコンテキストで渡す。
- `BUILD_PROFILE` の上流既定は `maxperf`。ビルド時間を縮めるため `release` にする。

## 13. 作り直しと復旧

| 状況 | 手順 |
|---|---|
| op-reth のデータが壊れた | データディレクトリを消して起動する。op-node が L1 の Batch から再構築する。Batch 未投稿のブロックは失われる。失われたブロックの取引は Gateway が送り直す（04 章 7.2）。各サービスは再編成として扱う |
| デモを最初からやり直したい | チェーンは作り直さない。`make demo-seed` で新しいデモ回を作り、場面 1 から行う（09 章 9 節）。登場人物のアドレスと、監査の集計区間が新しくなる |
| 初期状態に戻したい（遮断も違反の記録もない状態） | L1 へのデプロイからやり直す（3 節）。`make clean` で各サービスの DB も消す。Sepolia ETH を再度使う。同じ L1 コントラクトのままでは、過去の Batch から同じ状態が再構築される |

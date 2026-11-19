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
```

## 2. チェーンのパラメータ

| 項目 | 値 | 設定箇所 |
|---|---|---|
| L1 | Sepolia（chain ID 11155111） | - |
| L2 chain ID | 20261（`.env` の `L2_CHAIN_ID`） | op-deployer の `--l2-chain-ids` |
| L2 ブロック時間 | 2 秒 | intent の `deployOverrides.l2BlockTime` |
| ガス上限 | op-deployer の既定値 | 変更しない |
| EIP-1559 パラメータ | op-deployer の既定値 | 変更しない |
| L1 データ手数料 | 0 | `gasPriceOracleBaseFeeScalar = 0`、`gasPriceOracleBlobBaseFeeScalar = 0` |
| operator fee | 0 | 既定値 |
| 最小 base fee | 0 | 既定値 |
| データ可用性 | calldata | op-batcher の `--data-availability-type=calldata` |
| ハードフォーク | genesis 時点で全て有効。後から有効化しない | op-deployer の既定 |

L2 chain ID は chainlist と衝突しないことを M0 で確認する。

## 3. L1 へのデプロイ

`chain/scripts/deploy-l1.sh` が手順 1〜5、`chain/scripts/gen-config.sh` が手順 6〜7 を行う。`gen-config.sh` は `chain/runtime/jwt.txt` も作る。公式サンプル `docs/public-docs/create-l2-rollup-example/scripts/setup-rollup.sh` を元にする。

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
   op-deployer apply \
     --workdir chain/.deployer \
     --l1-rpc-url "$L1_RPC_URL" \
     --private-key "$ADMIN_PRIVATE_KEY"
   ```

6. 設定を取り出す。

   ```
   op-deployer inspect genesis --workdir chain/.deployer "$L2_CHAIN_ID" > chain/runtime/genesis.json
   op-deployer inspect rollup  --workdir chain/.deployer "$L2_CHAIN_ID" > chain/runtime/rollup.json
   ```

7. `chain/.deployer/state.json` から L1 コントラクトのアドレスを読み、`deployments/devnet.json` の `l1` に書く。使うのは `opChainDeployments[0].OptimismPortalProxy` と `SystemConfigProxy`。

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

## 4. 起動

`chain/compose/docker-compose.chain.yml` に 3 サービスを書く。公式サンプルの `docker-compose.yml` からの差分は次のとおり。

- op-reth のイメージを `${OP_RETH_IMAGE}` にする。
- proposer、challenger、dispute-mon を削る。
- 各コンポーネントに、役割に対応する鍵を渡す（公式サンプルは全部に同じ鍵を渡している）。

### 4.1 op-reth

```
node
--chain=/workspace/genesis.json
--datadir=/workspace/op-reth-data
--http --http.addr=0.0.0.0 --http.port=8545 --http.corsdomain=*
--http.api=debug,eth,net,txpool,web3
--ws --ws.addr=0.0.0.0 --ws.port=8546 --ws.origins=*
--ws.api=debug,eth,net,txpool,web3
--authrpc.addr=0.0.0.0 --authrpc.port=8551
--authrpc.jwtsecret=/workspace/jwt.txt
--rollup.disable-tx-pool-gossip
--builder.deadline=2
--builder.interval=100ms
```

- `debug` は Indexer が失敗理由を取るのに使う（07 章）。
- `--rollup.disable-tx-pool-gossip` は必須。取引を RPC だけで受け付けるようにする。

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
--resubmission-timeout=30s
```

- `BATCHER_MAX_CHANNEL_DURATION` は L1 ブロック数。既定は 25（約 5 分）。デモ中は 5（約 1 分）にする。値が小さいほど Sepolia ETH を多く使う。
- 公式サンプルは `OP_BATCHER_INBOX_ADDRESS` も設定している。要否は M0 で確認する（要確認）。

### 4.4 Sepolia への接続

- `L1_RPC_URL` は API キー付きのプロバイダを使う。公開エンドポイントは op-node の取得頻度で制限にかかることがある。
- `L1_BEACON_URL` は公式サンプルと同じ `https://ethereum-sepolia-beacon-api.publicnode.com` を既定にする。

## 5. L2 の初期化

`chain/scripts/bootstrap-l2.sh`（`make l2-bootstrap`）が行う。この時点では規則が無効なので、Gateway を通さない。

1. `contracts/script/Bootstrap.s.sol` を op-reth の RPC に対して `--broadcast` で実行する（下の表の手順 1〜13）。
2. forge の broadcast 記録（`contracts/broadcast/Bootstrap.s.sol/<chain ID>/run-latest.json`）から、アドレスとレシートのブロック番号を読む。
3. 開発用アカウント 1 から `cast send` で送金し、`ledgera: sender not allowed` で拒否されることを確認する。
4. `deployments/devnet.json` の `contracts`、`enforcementBlock`、`auditStartBlock` を書く。`l1` は `gen-config.sh` が書いた値を残す。

やり直しができるように、`Bootstrap.s.sol` は次の作りにする。

- コントラクトは CREATE2（固定の salt）でデプロイする。アドレスが毎回同じになる。
- 各手順は先に現在の状態を読む。済んでいれば飛ばす。判定はコードの有無、`getVasp`、`getAccount`、`balanceOf`、`allowance`、`enforcementEnabled`、`consortium`、`owner` で行う。

| 順 | 送信者 | 操作 |
|---:|---|---|
| 1 | 開発用アカウント 0 | L2 で送信する運営側アカウント（01 章 5.2）に 1 ETH ずつ送る |
| 2 | admin | `KycRegistry` の実装をデプロイする |
| 3 | admin | `ProxyAdmin.upgradeAndCall(0x42…0700, 実装, initialize(admin))` を呼ぶ |
| 4 | admin | `ConsortiumSafe`（所有者 3、しきい値 2）をデプロイして `setup` する |
| 5 | admin | `LedgerForwarder`、`TravelRuleCompliance`、`LedgerToken` × 2、`AtomicSwap`、`ReceiptLog` をデプロイする。`ReceiptLog` 以外の所有者は、いったん admin にする。続けて `bindToken`、`setSupportedToken`、`addAgent(issuer)` を呼び、`transferOwnership` で 03 章 1 節の表の所有者に移す。`ReceiptLog` には gateway のアドレスと所有者（`ConsortiumSafe`）をコンストラクタで渡す |
| 6 | admin | `registerVasp` で VASP 0、1、2 を登録する。管理者（admin、vasp-a-admin、vasp-b-admin）は同時に登録される |
| 7 | admin | `registerOperatorAccount` で gateway、issuer、consortium-1〜3、relayer-a、relayer-b を登録する |
| 8 | vasp-b-admin | `registerAccount` で vasp-b-treasury を `VASP_TREASURY` として登録する |
| 9 | issuer | vasp-b-treasury に tUSD 1,000,000 と tJPY 200,000,000 を Mint する |
| 10 | relayer-b | vasp-b-treasury が署名した `approve(AtomicSwap, 上限)` を 2 トークン分、`LedgerForwarder` 経由で送る |
| 11 | admin | `enableEnforcement()` を呼ぶ |
| 12 | admin | `transferConsortium(ConsortiumSafe)` を呼ぶ |
| 13 | admin | `ProxyAdmin.transferOwnership(ConsortiumSafe)` を呼ぶ |

`enforcementBlock` は手順 11 のブロック番号。`auditStartBlock` は手順 13 の次のブロック番号。

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

PostExec 種別の取引（ビルダーが合成するシステム取引）も検査しない。

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
- 判定は最新ブロックの状態で行う。スロット計算と判定は `op_revm::ledgera` を使う。
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
| | 同じブロック内で登録された直後の取引が通る |
| `op-reth` 結合 | プールが未登録の送信者を拒否し、メッセージが規定の文字列を含む |
| | プール検査を外した構成で、ペイロードが未登録の取引を含まない |

DevNet 上の確認は検証ノード（10 節）と E2E（[10-dev-ops.md](10-dev-ops.md)）で行う。

## 7. 到着順の処理（要件 16）

### 7.1 規則

取引を受け付けるのは Gateway。Gateway が振った通番の順に、L2 のブロックに取引が並ぶ。

実行層の順序付けは改造しない。次の条件を揃えることで、op-reth の既定の順序付けが到着順と一致する。

| 条件 | 担保する場所 |
|---|---|
| 取引を受け付けるのは Gateway だけ | op-reth の RPC の書き込みを Gateway 以外に開かない。取引の gossip を切る |
| Gateway は通番順に 1 件ずつ転送し、応答を待ってから次を送る | Gateway |
| すべての取引の priority fee が同じ | Gateway が `maxPriorityFeePerGas == 1 wei` 以外を拒否する |
| 受け付けた取引はプールですぐ実行可能になる | Gateway が nonce の連続、`maxFeePerGas`、残高を事前に検査する |

- op-reth のプールは、実効 priority fee が同じ取引を、実行可能になった順（`submission_id` の小さい順）に並べる。
- priority fee を 0 ではなく 1 wei にする理由。op-reth はブロックの構築中にペイロードを何度か作り直し、手数料の合計が増えたものだけを採用する。0 だと、取引を追加して作り直しても合計が変わらず、作り直したペイロードが捨てられる。その場合、スロットの途中で届いた取引は次のブロックに回る。

### 7.2 到着順の例外

次の場合は通番と異なる順になる。監査ツールは例外として記録する（07 章）。

| 場合 | 挙動 |
|---|---|
| Deposit 取引 | ブロックの先頭に入る。通番を持たない |
| 実行時に無効になった取引（残高不足、送信者の停止） | ブロックに入らない |
| ブロックのガス上限に収まらない取引 | 飛ばされ、後続が先に入ることがある |

3 つめは DevNet の取引量では起きない。

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

1. attacker が Sepolia で `depositTransaction` を呼ぶ。`msg.value` を付け、`data` にトークン送金などの呼び出しを入れる。
2. L2 に Deposit 取引が入る。規則により失敗 Deposit になる。
3. `data` の呼び出しは実行されない。attacker の L2 残高は mint 分だけ増える。
4. attacker はその ETH を動かせない。送信者として拒否されるため。

### 9.2 標準ブリッジ

- `L1StandardBridge` と `L1CrossDomainMessenger` 経由の入金は、規則の有効化後は失敗する。L2 側の送信者が Messenger の別名アドレスで、未登録のため。
- Messenger の別名アドレスは登録しない。登録すると、未登録の L1 利用者が L2 の任意の呼び出しを起動できる。
- 運営側アカウントが ETH を追加で持ち込むときは、そのアカウント自身が `depositTransaction` を呼ぶ。

## 10. 検証ノード（要件 9、26）

「どのノードが再実行しても同じ判定になる」ことを確認する構成。`chain/compose/docker-compose.replica.yml` に書く。

| サービス | 内容 |
|---|---|
| op-reth-replica | fork のイメージ。別のデータディレクトリ |
| op-node-replica | `--sequencer.enabled=false`、`--p2p.disable`。L1 の Batch だけからブロックを導出する |

確認方法。

- `chain/scripts/compare-heads.sh` が Sequencer の safe ブロックと検証ノードの同じ高さのブロックのハッシュを比べる。
- 未登録アドレスの Deposit を含むブロックで一致すれば、失敗 Deposit の判定が再現されている。

補足の確認（任意）。op-reth-replica を公式イメージ（`OP_RETH_STOCK_IMAGE`）に替えると、未登録アドレスの Deposit を含むブロックからハッシュが食い違う。規則が合意の一部であることを示せる。

## 11. 冗長化（要件 19）

実装は M7。`chain/compose/docker-compose.ha.yml` に書く。

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
OP_CONDUCTOR_EXECUTION_RPC=http://op-reth-N:8545
OP_CONDUCTOR_CONSENSUS_PORT=50050
OP_CONDUCTOR_RAFT_SERVER_ID=sequencer-N
OP_CONDUCTOR_RAFT_STORAGE_DIR=/data/raft
OP_CONDUCTOR_RAFT_BOOTSTRAP=true    # 1 台目だけ
OP_CONDUCTOR_PAUSED=true            # 起動時
```

起動後の手順。

1. 1 台目の op-conductor に `conductor_addServerAsVoter` で 2 台目と 3 台目を追加する。
2. 3 台に `conductor_resume` を送る。

引数と手順は M7 の着手時に公式手順と照合する（V11）。

### 11.3 Gateway の切替

op-conductor は未処理の取引を引き継がない。Gateway が再送する。

- Gateway は 3 つの op-conductor に 1 秒ごとに `conductor_leader` を問い合わせ、リーダーの op-reth を転送先にする。
- リーダーが変わったら、転送済みでブロックに入っていない取引を通番順に新しいリーダーへ送り直す。
- 通番と Receipt は Gateway の DB にあるので、切替で失われない。

詳細は [04-gateway.md](04-gateway.md) の 7 節。

ほかのサービスの読み取りは 3 台の URL を並べて指定する（01 章 8 節）。止まった組を避けて読む。

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
| op-reth のデータが壊れた | データディレクトリを消して起動する。op-node が L1 の Batch から再構築する。Batch 未投稿のブロックは失われる |
| L2 の状態を空に戻したい | L1 へのデプロイからやり直す（3 節）。Sepolia ETH を再度使う。同じ L1 コントラクトのままでは、過去の Batch から同じ状態が再構築される |
| デモを最初からやり直したい | チェーンは作り直さない。新しい顧客を作って場面 1 から行う |

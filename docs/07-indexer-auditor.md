# 07 Indexer と監査ツール

## 1. 分担

| サービス | 運営者 | 役割 | 要件 |
|---|---|---|---|
| indexer | ネットワーク運営 | L2 のブロックを監査 DB に取り込む。取引、残高、Registry の履歴を検索できるようにする | 12, 25 |
| auditor | 監査者 | 受付ログと L2 のブロックを照合し、到着順が守られたかを検査する。アドレス追跡と開示請求の窓口になる | 17, 21 |

auditor は Gateway と indexer の DB を読まない。公開 API と L2 の RPC だけを使う。

---

## 2. Indexer

### 2.1 取り込み

- 1 秒ごとに `eth_blockNumber` を読み、未取得のブロックを順に処理する。
- ブロックごとに `eth_getBlockByNumber(n, true)` と `eth_getBlockReceipts(n)` を呼ぶ。
- 開始位置は `INDEXER_START_BLOCK`（既定 0）。

再編成への対応。

- 取得したブロックの `parentHash` が、保存済みの 1 つ前のハッシュと違えば再編成とみなす。
- ハッシュが一致する高さまで遡り、それより上の行をすべての表から消して取り込み直す。
- すべての表は `block_number` を持つ。消す条件は `block_number > 分岐点`。

確定段階。

- 5 秒ごとに op-node の `optimism_syncStatus` を呼び、`unsafe_l2`、`safe_l2`、`finalized_l2` のブロック番号を `chain_status` に保存する。
- API は各ブロックの番号と比べて `unsafe`、`safe`、`finalized` を返す。

### 2.2 復号

`packages/abis` の ABI で、ログと取引の入力を復号する。

| イベント | 発行元 | 保存先 |
|---|---|---|
| `Transfer` | tJPY、tUSD | `token_transfers`、`balances_history` |
| `TravelRuleTransfer` | tJPY、tUSD | 同じ取引の `token_transfers.travel_rule_ref` |
| `TravelRuleAttestationConsumed` | `TravelRuleCompliance` | `travel_rule_attestations` |
| `AccountUpdated` | `KycRegistry` | `registry_account_events` |
| `VaspRegistered`、`VaspStatusChanged`、`VaspKeysChanged`、`VaspEndpointChanged` | `KycRegistry` | `registry_vasp_events` |
| `EnforcementEnabled` | `KycRegistry` | `chain_status` |
| `Filled` | `AtomicSwap` | `swaps` |
| `ApproveHash`、`ExecutionSuccess`、`ExecutionFailure` | `ConsortiumSafe` | `safe_events` |
| `Committed` | `ReceiptLog` | `receipt_commitments` |
| `AddressFrozen`、`TokensFrozen`、`TokensUnfrozen`、`Paused`、`Unpaused` | tJPY、tUSD | `token_admin_events` |

取引の入力。

- 宛先が既知のコントラクトなら、関数名と引数を `decoded_call` に保存する。
- `LedgerForwarder.execute` と `executeAll` は、内側のリクエストごとに署名者、呼び出し先、関数名も保存する。

残高。

- `Transfer` ごとに、送り手と受け手の新しい残高を `balances_history` に 1 行ずつ足す。
- 任意のブロック時点の残高は、そのブロック以前で最新の行。
- 100 ブロックごとに、動きのあったアドレスの残高を `balanceOf` と比べる。ずれたらエラーログを出す。

### 2.3 失敗理由

失敗した取引（レシートの `status` が 0）について理由を保存する。

| `failure_kind` | 判定 | 保存内容 |
|---|---|---|
| `REVERT` | `debug_traceTransaction`（`callTracer`）で最も深い失敗フレームの出力を取り、ABI のカスタムエラーとして復号できた | エラー名と引数 |
| `SENDER_NOT_ALLOWED` | Deposit 取引で、その時点の Registry で送信者が有効でない | 送信者の状態 |
| `UNKNOWN` | 上のどちらでもない | 生の出力 |

「その時点の Registry」は、`registry_account_events` と `registry_vasp_events` をその取引の直前まで適用した状態。

### 2.4 DB スキーマ

スキーマ名は `indexer`。主な表。

`blocks`

| 列 | 型 |
|---|---|
| `number` | bigint、主キー |
| `hash`、`parent_hash` | bytea |
| `timestamp` | timestamptz |
| `tx_count` | integer |

`transactions`

| 列 | 型 | 説明 |
|---|---|---|
| `hash` | bytea、主キー | |
| `block_number` | bigint | |
| `tx_index` | integer | |
| `type` | smallint | 2 は EIP-1559、126 は Deposit |
| `from_address`、`to_address` | bytea | `to_address` は null 可 |
| `value` | numeric(78,0) | |
| `nonce` | bigint | |
| `gas_limit`、`gas_used` | bigint | |
| `status` | smallint | 1 か 0 |
| `kind` | text | 下の一覧 |
| `decoded_call` | jsonb、null 可 | |
| `failure_kind` | text、null 可 | |
| `failure_detail` | jsonb、null 可 | |
| `mint` | numeric(78,0)、null 可 | Deposit の mint |

`kind` の値: `TOKEN_TRANSFER`、`TOKEN_MINT`、`TOKEN_BURN`、`SWAP`、`REGISTRY_UPDATE`、`SAFE_APPROVE`、`SAFE_EXECUTE`、`RECEIPT_COMMIT`、`L1_ATTRIBUTES`、`DEPOSIT`、`CONTRACT_DEPLOY`、`OTHER`。

`logs`（生のログ）

| 列 | 型 |
|---|---|
| `block_number` | bigint |
| `tx_hash` | bytea |
| `log_index` | integer |
| `address` | bytea |
| `topic0`〜`topic3` | bytea、null 可 |
| `data` | bytea |

`token_transfers`

| 列 | 型 |
|---|---|
| `block_number`、`log_index` | 主キー |
| `tx_hash` | bytea |
| `token` | bytea |
| `from_address`、`to_address` | bytea |
| `amount` | numeric(78,0) |
| `travel_rule_ref` | bytea、null 可 |

`balances_history`

| 列 | 型 |
|---|---|
| `token`、`account`、`block_number`、`log_index` | 主キー |
| `balance` | numeric(78,0) |

`registry_account_events`

| 列 | 型 |
|---|---|
| `block_number`、`log_index` | 主キー |
| `tx_hash` | bytea |
| `account` | bytea |
| `vasp_id` | integer |
| `kind`、`status` | smallint |
| `valid_until` | bigint |
| `version` | bigint |
| `actor` | bytea |
| `reason` | bytea |

`registry_vasp_events`、`travel_rule_attestations`、`swaps`、`safe_events`、`receipt_commitments`、`token_admin_events` は、対応するイベントの引数に `block_number`、`log_index`、`tx_hash` を足した形にする。

`chain_status`（1 行）

| 列 | 型 |
|---|---|
| `indexed_block` | bigint |
| `unsafe_block`、`safe_block`、`finalized_block` | bigint |
| `enforcement_enabled` | boolean |
| `registry_version` | bigint |

保存期間は定めない。DevNet では全件を残す。

### 2.5 API

認証なし。すべて GET。

| パス | 内容 |
|---|---|
| `/v1/status` | 取り込み済みブロック、確定段階ごとのブロック番号、規則の有効フラグ、Registry の版 |
| `/v1/blocks?limit=&before=` | ブロックの一覧 |
| `/v1/txs?limit=&before=&address=&kind=` | 取引の一覧 |
| `/v1/txs/:hash` | 取引の詳細 |
| `/v1/registry/accounts?vaspId=&status=` | アカウントの現在の状態の一覧 |
| `/v1/registry/accounts/:address` | 現在の状態と変更履歴 |
| `/v1/registry/accounts/:address/at?block=` | 指定ブロック時点の状態 |
| `/v1/registry/vasps` | VASP の一覧 |
| `/v1/accounts/:address/transfers?token=&limit=&before=` | 移転の履歴 |
| `/v1/accounts/:address/balances?block=` | 指定ブロック時点のトークン残高。省略時は最新 |
| `/v1/travel-rule/:refId` | 承認の消費と、対応する移転 |
| `/v1/swaps?address=` | 交換の一覧 |
| `/v1/safe/:safeTxHash` | 承認と実行のイベント |
| `/v1/receipt-commitments` | 受付ログのコミットの一覧 |

`/v1/txs/:hash` の例。

```json
{
  "hash": "0x…",
  "blockNumber": "1234",
  "txIndex": 1,
  "timestamp": "2026-11-19T03:00:02Z",
  "safety": "unsafe",
  "type": "eip1559",
  "from": "0x…",
  "to": "0x…",
  "status": "failed",
  "kind": "TOKEN_TRANSFER",
  "call": {
    "contract": "LedgerForwarder",
    "function": "execute",
    "inner": [
      { "signer": "0x…", "contract": "tUSD", "function": "transfer", "args": { "to": "0x…", "amount": "5000000000" } }
    ]
  },
  "failure": {
    "kind": "REVERT",
    "errorName": "AccountNotEligible",
    "args": { "account": "0x…" }
  },
  "events": []
}
```

### 2.6 設定

| 環境変数 | 既定 | 説明 |
|---|---|---|
| `PORT` | 8640 | |
| `DATABASE_URL` | - | |
| `DEPLOYMENTS_FILE` | - | |
| `L2_RPC_URL` | - | `debug` 名前空間が要る |
| `ROLLUP_RPC_URL` | - | op-node |
| `INDEXER_START_BLOCK` | 0 | |
| `POLL_INTERVAL_MS` | 1000 | |

anvil モードでは `ROLLUP_RPC_URL` を空にする。確定段階はすべて `unsafe` として返す。

### 2.7 テスト

| 種類 | 内容 |
|---|---|
| 単体 | 各イベントの復号と行の生成。残高の積み上げ |
| 単体 | 再編成: 分岐点より上の行が消え、取り込み直される |
| 結合（anvil） | 送金、交換、Registry 更新、Safe 実行の後、API が期待どおりの値を返す |
| 結合（anvil） | 指定ブロック時点の残高と Registry の状態が、その時点の `eth_call` と一致する |
| 結合（anvil） | 失敗取引の理由がカスタムエラー名で返る |

---

## 3. 監査ツール

### 3.1 入力

| 入力 | 取得元 |
|---|---|
| 受付ログ（Receipt、転送状態） | Gateway の `GET /v1/log` |
| L2 のブロックと取引 | `AUDIT_RPC_URL`。既定は Sequencer の op-reth。検証ノード（02 章 10 節）も指定できる。その場合、検出は L1 への Batch 掲載まで遅れる |
| Receipt の署名者、`genesisHash`、コミット | `ReceiptLog` の参照関数と `Committed` イベント |
| 監査の開始ブロック | デプロイ結果の `auditStartBlock` |

### 3.2 検査

| 記号 | 名前 | 内容 | 違反の種別 |
|---|---|---|---|
| C1 | 署名 | 各 Receipt の署名から復元したアドレスが `gatewaySigner` と一致する | `BAD_SIGNATURE` |
| C2 | 連鎖 | 通番が 1 から連続する。`entryHash` を再計算した値が一致する。`prevHash(n) == entryHash(n - 1)`、`prevHash(1) == genesisHash` | `BROKEN_CHAIN` |
| C3 | コミット | 各 `Committed(fromSeq, toSeq, headHash)` について、再計算した `entryHash(toSeq)` が `headHash` と一致する。範囲が連続する | `COMMIT_MISMATCH` |
| C4 | 順序 | ブロックに入ったエントリを通番順に並べたとき、位置（ブロック番号、ブロック内の番号）が単調に増える | `ORDER_VIOLATION` |
| C5 | 取り込み | 転送済みで未取り込みのエントリについて、監査先ノードの先頭ブロックの時刻 ≤ 受付時刻 + `INCLUSION_DEADLINE_SEC`（120 秒） | `NOT_INCLUDED` |
| C6 | 無受付 | 開始ブロック以降の Deposit 以外の取引すべてに、対応する Receipt がある | `UNRECEIPTED_TX` |
| C7 | 時刻 | 受付時刻 ≤ 取り込まれたブロックの時刻 + `TIME_TOLERANCE_SEC`（5 秒） | `RECEIPT_AFTER_INCLUSION` |

C4 の報告。通番順で隣り合う取り込み済みエントリのうち、位置が逆転している組をすべて挙げる。証拠として 2 つの Receipt と 2 つの位置を付ける。

C5 は、時計ではなく監査先ノードのブロック時刻で測る。監査先が遅れているノードでも、誤って違反にしない。

違反にしないもの。

| 場合 | 扱い |
|---|---|
| Deposit 取引 | 検査の対象外。通番を持たない |
| 転送状態が `rejected` のエントリ | 「理由つきの除外」として記録する。違反ではない |
| 理由が `ledgera: sender not allowed` の除外 | 受付時刻の直後のブロックで `KycRegistry.isActive(sender)` を呼ぶ。true なら `UNJUSTIFIED_EXCLUSION` の違反にする |

検査できないこと。

- Gateway が Receipt を出さずに取引を捨てた場合。ログに残らないので検出できない。
- C6 は、Gateway を通さずにブロックへ入った取引を検出する。Gateway に届かなかった取引は検出しない。

### 3.3 実行

- 10 秒ごとに、前回の続きから差分を検査する。
- `POST /v1/fifo/run` で通番 1 から全件を検査し直す。
- 進行位置（検査済みの通番とブロック番号）は DB に持つ。

CLI。

```
pnpm --filter @ledgera/auditor fifo --from 1 --json
```

違反が 1 件でもあれば終了コード 1。

### 3.4 アドレス追跡と開示請求

- 追跡は indexer の API を呼んでまとめる。返すのは、Registry の現在の状態と履歴、トークン残高、移転の履歴。
- 氏名は返さない。監査ツールは個人情報を持たない。
- 開示請求は、Registry から所属 VASP と `endpoint` を引き、その VASP の `POST /vasp/v1/disclosure-requests` に送る。
- VASP が承認すると、`GET /v1/disclosures/:id` が開示内容を返す。開示内容は DB に保存しない。VASP から都度取得する。

### 3.5 API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/v1/fifo/summary` | 検査済みの通番とブロック、検査ごとの件数、違反の件数 |
| GET | `/v1/fifo/entries?fromSeq=&limit=` | エントリごとの Receipt、位置、検査結果 |
| GET | `/v1/fifo/violations` | 違反の一覧 |
| POST | `/v1/fifo/run` | 全件の再検査 |
| GET | `/v1/trace/:address` | アドレスの追跡結果 |
| GET | `/v1/trace/:address/balances?block=` | 指定ブロック時点の残高 |
| POST | `/v1/disclosures` | 開示請求 |
| GET | `/v1/disclosures/:id` | 開示請求の状態と、承認済みなら開示内容 |

`/v1/fifo/violations` の例。

```json
{
  "violations": [
    {
      "id": 1,
      "check": "C4",
      "type": "ORDER_VIOLATION",
      "detectedAt": "2026-11-19T03:20:10Z",
      "detail": "通番 57 が通番 58 より後のブロック位置にある",
      "evidence": {
        "earlier": { "receipt": { "seq": "57", "txHash": "0x…", "receivedAtMs": "…", "signature": "0x…" }, "position": { "block": "1502", "index": 2 } },
        "later":   { "receipt": { "seq": "58", "txHash": "0x…", "receivedAtMs": "…", "signature": "0x…" }, "position": { "block": "1502", "index": 1 } }
      }
    }
  ]
}
```

### 3.6 DB スキーマ

スキーマ名は `auditor`。

| 表 | 列 |
|---|---|
| `audit_state` | `last_seq`、`last_block`、`updated_at` |
| `fifo_entries` | `seq`（主キー）、`tx_hash`、`received_at_ms`、`forward_status`、`pos_block`、`pos_index`、`checks`（jsonb） |
| `violations` | `id`、`check_code`、`type`、`seq_a`、`seq_b`、`tx_hash`、`detail`、`evidence`（jsonb）、`detected_at` |
| `disclosures` | `id`、`address`、`vasp_id`、`vasp_request_id`、`reason`、`status`、`created_at` |

### 3.7 設定

| 環境変数 | 既定 | 説明 |
|---|---|---|
| `PORT` | 8650 | |
| `DATABASE_URL` | - | |
| `DEPLOYMENTS_FILE` | - | |
| `AUDIT_RPC_URL` | - | L2 の RPC |
| `GATEWAY_URL` | - | 公開 API だけを使う |
| `INDEXER_URL` | - | |
| `VASP_AUDITOR_KEYS` | - | JSON。VASP ID → 開示請求用の API キー |
| `INCLUSION_DEADLINE_SEC` | 120 | C5 |
| `TIME_TOLERANCE_SEC` | 5 | C7 |
| `AUDIT_INTERVAL_SEC` | 10 | |

### 3.8 テスト

| 種類 | 内容 |
|---|---|
| 単体 | 合成したログとブロックで、C1〜C7 がそれぞれ違反を検出する。正常なデータでは 0 件 |
| 単体 | Deposit と理由つきの除外を違反にしない |
| 結合（anvil） | Gateway 経由で 100 件送り、違反 0 件 |
| 結合（anvil） | Gateway の `reorder-next` の後、C4 の違反が 1 件出て、証拠に 2 つの Receipt が入る |
| 結合（anvil） | Gateway を通さずに送った取引が C6 で検出される |
| 結合（anvil） | 開示請求から開示内容の取得まで |

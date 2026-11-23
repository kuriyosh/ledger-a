# 08 デモ画面とデモ用ツール

## 1. 画面の構成

1 つの Next.js アプリ（`apps/web`）に全役割の画面を入れる。

```
+--------------------------------------------------------------+
| 役割タブ: ユーザー A | ユーザー B | VASP A | VASP B |        |
|           コンソーシアム | 監査者 | 外部者      [デモ操作]   |
+--------------------------------------+-----------------------+
|                                      |                       |
|  役割ごとの画面（左、幅 60%）        |  チェーン表示         |
|                                      |  （右、幅 40%、常時） |
|                                      |                       |
+--------------------------------------+-----------------------+
```

- 左は役割タブで切り替える。右のチェーン表示は切り替えても残る。
- 左で操作すると、右の取引一覧に 5 秒以内に反映される。内訳はブロックの生成 2 秒、indexer の取得 1 秒、画面の再取得 2 秒。
- 文言は日本語。

| パス | 画面 |
|---|---|
| `/` | 役割の選択 |
| `/user/a`、`/user/b` | ユーザー（VASP のウォレットアプリ） |
| `/vasp/a`、`/vasp/b` | VASP 管理 |
| `/consortium` | コンソーシアム |
| `/auditor` | 監査者 |
| `/attacker` | 外部者 |

## 2. データの取得

- ブラウザは Next.js の Route Handler（`/api/<サービス名>/...`）を経由する。中継はループバックの Host だけを受け付ける。
- Route Handler が管理者用の API にサービスごとのトークンを付ける。開示請求には監査者用のトークンを付ける。トークンは Web サーバー内で使う。
- ユーザーのセッショントークンは VASP ごとに `sessionStorage` に持つ。
- 取得は TanStack Query。一覧は 2 秒、進行中の操作は 1 秒ごとに再取得する。

| Route Handler | 転送先 |
|---|---|
| `/api/vasp-a/*`、`/api/vasp-b/*` | vasp-a、vasp-b |
| `/api/consortium/*` | consortium |
| `/api/indexer/*` | indexer |
| `/api/auditor/*` | auditor |
| `/api/gateway/*` | gateway（公開 API だけ） |
| `/api/demo/*` | demo-tools |

## 3. ユーザー画面

対象は VASP の顧客。`/user/a` は VASP A、`/user/b` は VASP B の API を呼ぶ。

| 状態 | 表示 |
|---|---|
| 未ログイン | 口座開設フォーム（氏名、生年月日、国、住所、メール）。既存顧客はメールでログイン |
| 審査待ち | 「審査中」。2 秒ごとに状態を確認する |
| 承認済み | ホーム |

ホームの要素。

| 要素 | 内容 | API |
|---|---|---|
| 残高 | tJPY、tUSD | `GET /v1/me/balances` |
| アドレス | 短縮表示とコピー | `GET /v1/me` |
| 送金 | 宛先アドレス、受取人の氏名、トークン、金額。手数料は「0 円」と表示する | `POST /v1/me/transfers` |
| 送金の進行 | 相手 VASP の確認中 → 承認済み → 送信済み（通番）→ 完了。失敗時は理由 | `GET /v1/me/transfers/:id` |
| 交換 | 売るトークン、買うトークン、金額 → 見積もり（レート、残り秒数）→ 実行 | `POST /v1/me/swaps/quote`、`POST /v1/me/swaps` |
| 履歴 | 送金、入金、交換 | `GET /v1/me/transfers` |

デモ用の操作（`DEMO_MODE` のときだけ表示）。

| 操作 | 効果 |
|---|---|
| 「確認を飛ばして送る」 | `demo.skipChecks` を付けて送金する |
| 「期限切れの見積もりで実行」 | 見積もりの期限後に、`demo.allowExpired` を付けて交換する |

`DEMO_MODE` のときは、口座開設とログインのメールアドレス欄に、現在のデモ回の値を初期表示する（例: `sato.r3@example.com`）。回ごとに別の顧客になる（[09-flows.md](09-flows.md) の 9 節）。

失敗理由の表示。

| `errorCode` | 文言 |
|---|---|
| `SignerNotAllowed` | あなたのアドレスは現在取引できません |
| `AccountNotEligible` | 相手、またはあなたのアドレスは取引できません |
| `TravelRuleRequired` | 相手の事業者の確認が必要な送金です |
| `QuoteExpired` | 見積もりの有効期限が切れました |
| `AccountFrozen`、`EnforcedPause` | このトークンは現在動かせません |
| その他 | エラー名をそのまま表示する |

## 4. VASP 管理画面

| タブ | 内容 | 操作 |
|---|---|---|
| 顧客 | ID、氏名、KYC の状態、アドレス、Registry の状態 | 承認、却下、停止、停止の解除、入金（デモ） |
| トラベルルール（受信） | 送付 VASP、金額、受取人、氏名の照合結果、状態 | 承認、却下 |
| トラベルルール（送信） | 相手 VASP、金額、状態、取引ハッシュ | - |
| アラート | 規則、対象の顧客、金額、状態、根拠の入金の確定段階、申請の進行（承認 n / 2） | 凍結を申請、閉じる |
| 開示請求 | アドレス、請求者、理由、状態 | 承認、却下 |

- 氏名などの個人情報が見えるのはこの画面とユーザー画面だけ。
- 根拠の入金が再編成で消えたアラートは「無効」と表示する。遮断済みのアラートには「根拠の入金が消えた」と表示する（05 章 4.6）。
- 「Registry の状態」は indexer から取る。VASP の DB の値と並べて表示する。
- 「入金（デモ）」は、法定通貨の入金があったものとして、顧客のアドレスにトークンを発行する。demo-tools の `POST /v1/issuer/mint` を呼ぶ。`DEMO_MODE` のときだけ表示する。

## 5. コンソーシアム画面

| 要素 | 内容 |
|---|---|
| 構成員の切替 | 構成員 1、2、3 のどれとして操作するかを選ぶ |
| 申請の一覧 | 種別、対象、理由、申請者、状態、承認数 |
| 申請の詳細 | 呼び出し先、関数、引数、`safeTxHash`、承認者ごとの取引ハッシュとブロック |
| 操作 | 承認、実行、取り下げ |
| Registry の概要 | VASP の一覧（ID、名前、状態）、規則の有効フラグ、バージョン |

- 承認すると、右のチェーン表示に `approveHash` の取引が出る。
- 実行すると、`execTransaction` の取引と `AccountUpdated` のイベントが出る。
- 承認のある申請の取り下げは、2 人の構成員が順に「取り下げ」を押す。チェーン表示に、取消取引の `approveHash` と `execTransaction` が出る（06 章 4.4）。1 人目が押した後は「取り下げ中（1 / 2）」と表示する。
- VASP から取り下げの依頼がある申請には、依頼の理由を表示し、「実行」を無効にする。
- 実行に失敗した申請には「再実行」と「取り下げ」を出す。

## 6. 監査者画面

### 6.1 到着順の監査

| 要素 | 内容 | API |
|---|---|---|
| 集計区間 | 「この回」と「全期間」を切り替える。既定は「この回」 | demo-tools の `GET /v1/demo/runs/current` |
| 概要 | 検査済みの通番とブロック、検査ごとの結果、違反の件数、除外の件数 | `GET /v1/fifo/summary` |
| エントリの表 | 通番、受付時刻、取引ハッシュ、送信者、ブロック位置、判定 | `GET /v1/fifo/entries` |
| 違反の一覧 | 種別、説明、証拠（2 つの Receipt と位置） | `GET /v1/fifo/violations` |
| 除外の一覧 | 未採用のうち理由を確認できたもの。理由、確認したブロック、読んだ値 | `GET /v1/fifo/exclusions` |
| コミット | 範囲、範囲の最後のエントリのハッシュ、L2 の取引 | indexer の `GET /v1/receipt-commitments` |
| 再検査 | 全件を検査し直す | `POST /v1/fifo/run` |

- 違反のある行は色を変える。証拠の Receipt は署名付きの JSON をそのまま見せる。
- 「この回」は、現在のデモ回の開始通番と開始ブロックを `fromSeq`、`fromBlock` に渡す。検査そのものは全期間に対して行われている（07 章 3.3）。
- `DEMO_MODE` でないときは「全期間」だけを表示する。

### 6.2 アドレスの追跡

| 要素 | 内容 | API |
|---|---|---|
| 検索 | アドレスを入力する | `GET /v1/trace/:address` |
| 登録情報 | 所属 VASP、種別、状態、期限、変更履歴 | `GET /v1/trace/:address` |
| 残高 | 現在の残高。ブロック番号を指定すると、その時点の残高 | `GET /v1/trace/:address/balances` |
| 移転履歴 | 相手、金額、トラベルルールの参照 ID、取引ハッシュ | `GET /v1/trace/:address` |
| 氏名 | 「非開示」と表示する | - |
| 開示請求 | 理由を入力して所属 VASP に請求する。承認されると氏名が出る | `POST /v1/disclosures`、`GET /v1/disclosures/:id` |

## 7. 外部者画面

登録されていないアドレス（attacker）の操作画面。見た目はターミナル風にする。

| 要素 | 内容 |
|---|---|
| 状態 | アドレス、Registry の状態（未登録）、Sepolia の残高、L2 の残高、`DepositProbe` のカウンタ |
| 操作ボタン | 下の表 |
| 出力 | 送った内容、RPC のエラー文、取引ハッシュ、レシートの状態を時系列で出す |

| 操作 | demo-tools の API | 期待する結果 |
|---|---|---|
| L1 から Deposit で L2 のコントラクトを呼ぶ | `POST /v1/attacker/l1-deposit` | L2 のブロックに入るが失敗。`DepositProbe` のカウンタは増えない。L2 の残高は mint 分だけ増える |
| L2 に直接トークン送金 | `POST /v1/attacker/l2-send`（`route: direct`、`action: token-transfer`） | `ledgera: sender not allowed` |
| L2 に直接 ETH 送金 | 同（`action: eth-transfer`） | 同上 |
| L2 に直接コントラクトをデプロイ | 同（`action: deploy`） | 同上 |
| Gateway 経由で送金 | 同（`route: gateway`） | 同上。Receipt は出ない |

- L2 の残高が、取引に必要な残高（10.1 の表）に足りないときは、直接送信のボタンを無効にする。op-reth は規則の判定より先に残高を確かめる。足りないと残高不足のエラーが出て、規則による拒否を見せられない。最初に Deposit を行う。
- 出力では、エラー文が `ledgera: sender not allowed` を含むときだけ「規則による拒否」と表示する。それ以外のエラーは文面をそのまま出す。

## 8. チェーン表示

右側に常時表示する。4 つのタブを持つ。

### 8.1 取引

| 列 | 内容 |
|---|---|
| 時刻 | ブロックの時刻 |
| 種類 | `kind` に対応するラベル（送金、交換、登録の更新、承認、実行、Deposit など） |
| 送り手 → 受け手 | アドレスの短縮形と、Registry の種別と所属（例: 顧客 / VASP A） |
| 金額 | トークンと数量 |
| 結果 | 成功、または失敗と理由 |
| 確定段階 | `unsafe` → `safe` → `finalized` のバッジ |
| 通番 | Gateway の通番。Deposit は「L1 経由」 |

- 新しい取引が上に入る。L1 属性取引（`L1_ATTRIBUTES`）は既定で隠す。
- 行を開くと、復号した呼び出し、イベント、失敗理由、Receipt を表示する。
- データは indexer の `GET /v1/txs`。通番は Gateway の `POST /v1/receipts/lookup` で、表示中の取引ハッシュからまとめて取得する。

### 8.2 登録簿

「オンチェーンにある情報」と「VASP の DB にある情報」を左右に並べる。

| オンチェーン（誰でも見える） | | | | VASP の DB（その VASP だけ） |
|---|---|---|---|---|
| アドレス | VASP | 種別 | 状態 | 氏名 |
| `0x12…ab` | VASP A | 顧客 | 有効 | 佐藤 太郎 |
| `0x34…cd` | VASP B | 顧客 | 遮断 | Lim Wei |

- 左は indexer の `GET /v1/registry/accounts`。
- 右は各 VASP の `GET /v1/admin/addresses`。列の見出しに「チェーンには載らない」と書く。
- 右の列は表示の切替ができる。隠すと、チェーンから見える情報だけになる。
- `DEMO_MODE` のときは、既定で現在のデモ回に登録されたアドレスだけを表示する。indexer に `registeredFromBlock`（回の開始ブロック）を渡す。「全期間」に切り替えると、運営側のアカウントと過去の回のアドレスも出る。

### 8.3 L1

| 要素 | 内容 |
|---|---|
| safe なブロック | L1 に Batch が公開された L2 ブロックの番号 |
| Batcher | Sepolia Etherscan の batcher アドレスのページへのリンク |
| Deposit | 外部者が送った Deposit の L1 取引と、対応する L2 取引 |

### 8.4 ネットワーク

| 要素 | 内容 |
|---|---|
| ブロック高 | 最新の L2 ブロック |
| 規則 | 有効か無効か。Registry のバージョン |
| Gateway | 最新の通番、コミット済みの通番、キューの長さ |
| Sequencer | 冗長化構成のとき、3 台の状態とリーダー |

## 9. デモ操作

画面右上の「デモ操作」から開く。`DEMO_MODE` のときだけ表示する。

| 操作 | 効果 | API |
|---|---|---|
| 次の 2 件の順序を入れ替える | Gateway の仕掛けを 1 回分有効にする（04 章 12 節） | demo-tools の `POST /v1/demo/reorder-next` |
| 仕掛けの状態 | 待機中、保留中、完了 | demo-tools の `GET /v1/demo/state` |
| 現在のデモ回 | 回の番号、開始時刻、開始通番、開始ブロック | demo-tools の `GET /v1/demo/runs/current` |

- Sequencer の停止（場面 7）は画面から行わない。`make ha-kill-leader` を端末で実行する。
- 新しいデモ回も画面から作らない。`make demo-seed` を端末で実行する。

## 10. demo-tools

デモ専用のサービス。`DEMO_MODE=true` でなければ起動しない。

### 10.1 API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/v1/attacker/status` | アドレス、Registry の状態、L1 と L2 の残高、`DepositProbe` のカウンタ、操作ごとに必要な残高 |
| POST | `/v1/attacker/l1-deposit` | Sepolia の `OptimismPortal` に Deposit を送る |
| GET | `/v1/attacker/deposits/:l1TxHash` | Deposit の進行 |
| POST | `/v1/attacker/l2-send` | L2 に取引を送る |
| POST | `/v1/issuer/mint` | 発行体の鍵でトークンを発行する |
| POST | `/v1/demo/reorder-next` | Gateway の `POST /admin/demo/reorder-next` を呼ぶ |
| GET | `/v1/demo/state` | Gateway の `GET /admin/demo/state` を呼ぶ |
| POST | `/v1/demo/runs` | 新しいデモ回を作る。`make demo-seed` が呼ぶ |
| GET | `/v1/demo/runs/current` | 現在のデモ回 |

発行とデモ回の開始には `Authorization: Bearer` で `GATEWAY_ADMIN_TOKEN` を送る。

`POST /v1/issuer/mint`

```json
{ "token": "tJPY", "to": "0x…", "amount": "2000000000000" }
```

- 発行体（issuer）の鍵で `LedgerToken.mint(to, amount)` に署名し、Gateway の `/rpc` に送る。
- 取り込みが確認できると `txHash` と `status: "confirmed"` を返す。
- 同じ `Idempotency-Key` と同じ発行内容で再送すると同じ取引を照合する。同じキーで発行内容が変わった場合は 409 を返す。

`POST /v1/attacker/l1-deposit`

```json
{ "mintEth": "0.001", "action": "probe" }
```

- `OptimismPortal.depositTransaction` を attacker の鍵で送る。`msg.value` は `mintEth`。
- `action` が `probe` なら、`to` は `DepositProbe`、`data` は `poke()`。`none` なら `to` は attacker 自身、`data` は空。
- 宛先をトークンにする `action` は用意しない。トークンへの送金は、標準の実行層でもトークンの検査で失敗する。実行層の規則が効いた証拠にならない（02 章 9.1）。
- `depositTransaction` の L2 側のガス上限（`_gasLimit`）は 200,000 を明示する。L2 での見積もりは呼ばない。未登録の送信者では見積もりが失敗するため。
- L2 側の取引ハッシュは L1 のレシートの `TransactionDeposited` ログから求める。viem の `viem/op-stack` の `getL2TransactionHashes` を使う。

`GET /v1/attacker/deposits/:l1TxHash`

```json
{
  "l1TxHash": "0x…",
  "l1Status": "confirmed",
  "l2TxHash": "0x…",
  "l2Status": "failed",
  "l2BalanceWei": "1000000000000000",
  "probeCountBefore": "0",
  "probeCountAfter": "0"
}
```

- `l2Status` は `pending`（まだ L2 に入っていない）、`failed`、`success`。
- `probeCountBefore` は Deposit を送った時点、`probeCountAfter` は現在の `DepositProbe.count(attacker)`。規則が効いていれば同じ値になる。

`POST /v1/attacker/l2-send`

```json
{ "route": "direct", "action": "token-transfer" }
```

| `route` | 送信先 |
|---|---|
| `direct` | op-reth の RPC（`L2_DIRECT_RPC_URL`）。rpc-proxy を通さない |
| `gateway` | Gateway の `/rpc` |

| `action` | 取引 |
|---|---|
| `token-transfer` | `tUSD.transfer(宛先, 1 tUSD)` |
| `eth-transfer` | 宛先に 1 wei を送る |
| `deploy` | 最小のコントラクトをデプロイする |

応答。

```json
{ "accepted": false, "error": { "code": -32000, "message": "ledgera: sender not allowed: 0x…" } }
```

取引の作り方。

- EIP-1559、priority fee 1 wei。Gateway の形式検査を通し、登録状態の検査で止まることを見せるため。
- `gas`、`nonce`、手数料をすべて明示し、手元で署名して `eth_sendRawTransaction` で送る。`eth_estimateGas` を呼ばない。未登録の送信者では見積もりの段階でエラーになり、プールや Gateway に届かないため。
- `maxFeePerGas` は `ATTACKER_MAX_FEE_PER_GAS_WEI`（既定 3 gwei）。共通の `MAX_FEE_PER_GAS_WEI`（100 gwei）は使わない。
- 直接送信に使う鍵は attacker だけ。発行体の取引は Gateway に送る。

手数料を別に決める理由。op-reth のプールは、規則の判定より先に標準の検証を行う（02 章 6.4）。標準の検証は、残高が `gas × maxFeePerGas + value` 以上であることを求める。外部者の L2 残高は Deposit の mint（0.001 ETH）だけ。

| `action` | `gas` | 必要な残高（3 gwei） | 100 gwei の場合 |
|---|---:|---:|---:|
| `token-transfer` | 100,000 | 0.0003 ETH | 0.01 ETH |
| `eth-transfer` | 100,000 | 0.0003 ETH ＋ 1 wei | 0.01 ETH ＋ 1 wei |
| `deploy` | 200,000 | 0.0006 ETH | 0.02 ETH |

- 3 gwei なら、3 つとも 0.001 ETH で足りる。100 gwei では残高不足で落ち、規則のエラーにならない。
- 3 gwei は Gateway の形式検査（`maxFeePerGas >= base fee × 2 + 1`）も通る。L2 の base fee は genesis で 1 gwei。DevNet の取引量では上がらず、空のブロックが続くと下がる。
- L1 データ手数料は 0 なので、必要な残高に加えない（02 章 2 節）。

送る前の確認。標準の検証のエラーを、規則による拒否と取り違えないために行う。

- attacker の L2 残高が、上の表の必要な残高以上である。
- `maxFeePerGas` が `現在の base fee × 2 + 1` 以上である。
- どちらかを満たさなければ送らず、409 `ATTACKER_NOT_READY` を返す。`details` に不足の内容を入れる。

`POST /v1/demo/runs`

本文なし。新しいデモ回を作る（[09-flows.md](09-flows.md) の 9 節）。

1. 回の番号を 1 増やす。
2. Gateway の `GET /v1/log/head` と L2 の最新ブロックから、開始通番（最新の通番 + 1）と開始ブロック（最新のブロック + 1）を決める。
3. 登場人物を作る（[10-dev-ops.md](10-dev-ops.md) の 5 節の表）。各 VASP の API を、申込、KYC の承認、発行の順に呼ぶ。メールアドレスは `<名前>.r<回の番号>@example.com`。
4. すべての登場人物が揃うと回を公開する。途中の回が残っている場合は、同じ番号と開始位置で再開する。

- 登場人物の氏名とメールアドレスは保存しない。メールアドレスは回の番号から決まる。個人情報を持つのは VASP だけにする。

`GET /v1/demo/runs/current`

```json
{
  "run": 3,
  "startedAt": "2026-11-19T03:00:00Z",
  "startSeq": "412",
  "startBlock": "20510",
  "emailSuffix": ".r3@example.com"
}
```

デモ回が 1 つもないときは 404 を返す。画面は「全期間」で表示する。

### 10.2 設定

| 環境変数 | 説明 |
|---|---|
| `PORT` | 8660 |
| `DEMO_MODE` | true でなければ起動時に終了する |
| `DATABASE_URL` | スキーマ名は `demo`。回を `runs` に、署名済み発行取引を `mint_requests` に保存する |
| `DEPLOYMENTS_FILE` | |
| `L1_RPC_URL`、`L2_RPC_URL`、`GATEWAY_URL` | `L2_RPC_URL` は読み取り用。rpc-proxy を指す |
| `L2_DIRECT_RPC_URL` | op-reth の URL。外部者の直接送信だけに使う |
| `ATTACKER_PRIVATE_KEY` | |
| `ATTACKER_MAX_FEE_PER_GAS_WEI` | 外部者の取引の `maxFeePerGas`。既定は 3000000000（3 gwei） |
| `ISSUER_PRIVATE_KEY` | |
| `ATTACK_TARGET_ADDRESS` | 直接送信の送金の宛先。vasp-b-treasury のアドレス（`.env.generated` の `VASP_B_TREASURY_ADDRESS`）を渡す |
| `GATEWAY_ADMIN_TOKEN` | |
| `VASP_A_URL`、`VASP_B_URL`、`VASP_A_ADMIN_TOKEN`、`VASP_B_ADMIN_TOKEN` | デモ回の登場人物を作る |

## 11. web の設定

| 環境変数 | 説明 |
|---|---|
| `VASP_A_URL`、`VASP_B_URL` | |
| `VASP_A_ADMIN_TOKEN`、`VASP_B_ADMIN_TOKEN` | |
| `CONSORTIUM_URL`、`CONSORTIUM_ADMIN_TOKEN` | |
| `INDEXER_URL`、`AUDITOR_URL`、`GATEWAY_URL`、`DEMO_TOOLS_URL` | |
| `NEXT_PUBLIC_DEMO_MODE` | デモ用の操作を表示するか |
| `NEXT_PUBLIC_L1_EXPLORER_URL` | `https://sepolia.etherscan.io` |
| `NEXT_PUBLIC_BATCHER_ADDRESS` | |

## 12. テスト

- 画面の単体テストは書かない。API の結合テストと E2E（[10-dev-ops.md](10-dev-ops.md)）で担保する。
- デモの通し確認は [09-flows.md](09-flows.md) の場面ごとの「見せる画面」を手で追う。

# MakeShop クーポンAPI 実スキーマ（正本メモ）

> **このドキュメントの目的**
> 株主優待クーポン機能が使う **MakeShop GraphQL API（createCoupon）の実スキーマ**を、正本として記録する。
> MakeShop は **本番で introspection を無効化している（`__type` などが `code:FORBIDDEN` で拒否される）**ため、
> スキーマは「実際に叩いてエラーメッセージから確定させる」しかない。将来スキーマが変わったときに同じ苦労を
> 繰り返さないよう、確定済みの実スキーマとハマりどころをここに残す。
>
> **確定方法の履歴**：公式リファレンス（`https://developers.makeshop.jp/api/graphql/index.html`）は SpectaQL 製の
> 静的サイトで、HTML に全スキーマが埋め込まれている。ページHTMLを取得して該当型定義を抽出することで、
> introspection なしでもフィールド名・enum値・型を確定できた（2026-07 時点）。
>
> **最終更新**：2026-07-27

---

## 1. エンドポイントと認証（固定トークン方式）

- **エンドポイント**：`https://app-api.makeshop.jp/v1/graphql`（`.env` の `MAKESHOP_API_ENDPOINT`）。
- **認証**：固定トークン方式（**無期限・ローテーション不要**）。SSO/OAuth の「一時トークン5分/リフレッシュ12時間」とは**別系統**。
- **リクエストヘッダー**（公式サンプル準拠 / `functions/src/makeshop/client.ts`）：

| ヘッダー | 値 |
|---|---|
| `authorization` | `Bearer <ACCESS_TOKEN>` |
| `x-api-key` | `<API_KEY>` |
| `x-timestamp` | 現在の UNIX タイムスタンプ（**秒**）。リクエストごとに生成（保存不要） |
| `content-type` | `application/json` |

- 秘匿値（`ACCESS_TOKEN` / `API_KEY`）は **Secret Manager**（`MAKESHOP_ACCESS_TOKEN` / `MAKESHOP_API_KEY`、`functions/src/makeshop/secrets.ts`）で管理し、**発行を行う関数にのみ注入**する（`adminTestIssueCoupon` / `receiveClaimCoupon`）。エンドポイントURLは非秘匿なので `.env`。
- POST ボディ：`{ "query": "...", "variables": { ... }, "operationName": null }`。

---

## 2. createCoupon mutation

```graphql
mutation createCoupon($input: CreateCouponRequest!) {
  createCoupon(input: $input) {
    results {
      code
      name
      status
      errorMessage
    }
  }
}
```

- 戻り値の `code`/`name`/`status`/`errorMessage` は **`CreateCouponResponse` 直下ではなく `results` 配列の中**にある
  （直下に書くと `Cannot query field "status" ... on type "CreateCouponResponse"` エラー）。

### 2.1 入力：`CreateCouponRequest` は **配列**

```jsonc
// variables
{
  "input": {
    "coupons": [ { /* CreateCoupon を1件（複数一括も可能） */ } ]
  }
}
```

- `CreateCouponRequest` の唯一のフィールドは **`coupons: [CreateCoupon]!`**。
  → クーポン本体のフィールドは**各 `CreateCoupon` 要素の中**に書く（トップレベルに `name` 等を書くと
  `unknown field / path: variable.input.name` エラー）。gift-system は1件ずつ発行するので要素は1つ。

### 2.2 `CreateCoupon`（要素）の全フィールド

| フィールド | 型 | 説明 / gift-system での設定 |
|---|---|---|
| `code` | String | クーポンコード。gift-system 側でランダム生成して渡す（`codeAutoCreate` は使わない） |
| `codeAutoCreate` | Boolean | 自動採番フラグ（既定 false）。使わない |
| `name` | **String!** | クーポン名（**必須**）。種別名。手動再発行時は `名前【再発行 M/D】` |
| `isEnabled` | Boolean | 有効フラグ（既定 false）。→ **true**（発行後すぐ使える） |
| `isForOnlyMember` | Boolean | 会員限定（既定 false）。→ **true**（確定仕様） |
| `hasMaximumMemberUsableCount` | Boolean | 「1人あたり利用回数」を設定するか。→ **true**（`isForOnlyMember=true` が前提） |
| `maximumMemberUsableCount` | Uint64 | 1人あたり利用上限。→ **1**（お一人様1回） |
| `hasMemberGroupIds` | Boolean | 対象会員グループを絞るか（既定 false）。→ 使わない |
| `memberGroupIds` | [Int64!] | 対象会員グループID（`hasMemberGroupIds=true` かつ会員限定時）。→ 使わない |
| `hasMinimumPrice` | Boolean | 最低購入金額を設定するか（既定 false） |
| `minimumPrice` | Uint64 | 最低購入金額（`hasMinimumPrice=true` 時）。→ 種別に設定があれば付与 |
| `hasTotalUseCount` | Boolean | 「発行数（全体利用回数）」を設定するか。→ **true** |
| `totalUseCount` | Uint64 | 全体の利用上限。→ **1**（コードは株主1名専用。転送されても使い回せない） |
| `isTargetProduct` | Boolean | 対象商品を絞るか（既定 false）。→ **false**（＝全商品） |
| `discountType` | **DiscountType!** | 割引方式（必須 enum。下記） |
| `fixedAmount` | Uint64 | 定額割引（円）。`discountType=FIXED_AMOUNT` のとき |
| `fixedRate` | Uint64 | 定率割引（%）。`discountType=FIXED_RATE` のとき |
| `hasPeriod` | Boolean | 利用期間を設定するか。→ **true** |
| `startedAt` | String | 利用開始日時（`hasPeriod=true` のとき**必須**）。→ 発行時刻（今） |
| `endedAt` | String | 利用終了日時（`hasPeriod=true` のとき**必須**）。→ クーポン有効期限（`couponExpiryAt`） |

**`DiscountType` enum**：`FIXED_AMOUNT`（定額円）/ `FIXED_RATE`（定率%）/ `FREE_DELIVERY_FEE`（送料無料）。
gift-system 内部表現 `"amount"/"rate"` → `FIXED_AMOUNT`/`FIXED_RATE` に変換（`functions/src/makeshop/coupon.ts` の `DISCOUNT_TYPE_ENUM`）。

**日付書式**：`startedAt`/`endedAt` は **`YYYY-MM-DD HH:mm:ss`**（例 `2027-03-31 23:59:59`）。JST で組み立てる。
（リファレンスの例が Go 参照時刻 `2006-01-02 15:04:05` ＝ MakeShop バックエンドは Go。）

### 2.3 レスポンス

```jsonc
{
  "data": {
    "createCoupon": {
      "results": [
        { "code": "abc123...", "name": "株主優待10%OFF", "status": "SUCCESS", "errorMessage": null }
      ]
    }
  }
}
```

- 1件発行なので **`results[0]`** を見る。
- **`status` は enum `CreateCouponResultStatus` = `SUCCESS` / `FAIL`**。成功判定は `status === "SUCCESS"`。
- 失敗時は `status="FAIL"` ＋ `errorMessage` に理由。
- **GraphQLレベルのエラー**（不明フィールド・enum不一致・認証等）は**トップレベルの `errors[]`** に入る（`data` ではなく）。
  クライアント（`client.ts`）はこれを throw せず返し、`coupon.ts` が `errorMessage` に集約する。

---

## 3. ハマりどころ（重要）

1. **introspection は本番で無効**（`code:FORBIDDEN`）。スキーマ変更時は **実際に叩いてエラーメッセージから確定**するか、
   公式リファレンス（SpectaQL 静的HTML）から型定義を抽出する。`__type` クエリは使えない前提。
2. **入力は `coupons` 配列**。トップレベルにフィールドを置くと `unknown field / path: variable.input.<name>`。
3. **`useCountType`（例 `UENUCT4`）は API に存在しない**。管理画面の手動作成UIの概念であって、API では
   **`hasMaximumMemberUsableCount`＋`maximumMemberUsableCount`** と **`hasTotalUseCount`＋`totalUseCount`** の
   **boolフラグ＋数値**で表す。「1人1回」= 会員限定＋`maximumMemberUsableCount:1`（＋全体 `totalUseCount:1`）。
4. **レスポンスは `results` 配列**。直下に `status` 等を問い合わせると 422。
5. **`status` は `SUCCESS`/`FAIL`**（`OK`/`NG` ではない）。
6. **日付は `YYYY-MM-DD HH:mm:ss`**（date だけだと期間指定でエラーになりうる）。`hasPeriod=true` なら `startedAt`/`endedAt` 必須。
7. **`x-timestamp` は毎リクエスト必須**（秒）。認証は Bearer＋`x-api-key` の併用。

---

## 4. 関連コード

| ファイル | 役割 |
|---|---|
| `functions/src/config/makeshop.ts` | エンドポイント・資格情報の参照、`isMakeshopConfigured()` |
| `functions/src/makeshop/secrets.ts` | `defineSecret("MAKESHOP_ACCESS_TOKEN"/"MAKESHOP_API_KEY")` |
| `functions/src/makeshop/client.ts` | 固定ヘッダーの GraphQL トランスポート＋診断（url/method/headerKeys/httpStatus/bodyText） |
| `functions/src/makeshop/coupon.ts` | `createCouponRaw`/`createCouponWithRetry`（重複コード再生成）/`generateCouponCode`/`reissueName`。**スキーマ差し替えはここの `MUTATION`/`buildInput`** |
| `functions/src/makeshop/issue.ts` | claim→発行→保存のオーケストレーション（二重発行防止・再発行・失敗復元） |
| `functions/src/makeshop/introspect.ts` | introspection ヘルパ（本番では FORBIDDEN。将来有効化された時のため残置） |

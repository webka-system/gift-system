/**
 * MakeShop API の秘匿値（Secret Manager / defineSecret）
 *
 * MakeShop のサーバー間 GraphQL 連携は **固定トークン方式**（無期限・ローテーション不要）:
 *   - ACCESS_TOKEN … authorization: Bearer <ACCESS_TOKEN> に載せる。
 *   - API_KEY      … x-api-key: <API_KEY> に載せる。
 * NE のような access/refresh トークン更新（persistRotatedTokens）は不要。固定ヘッダーを付けて叩くだけ。
 *
 * 秘匿値は Firebase 推奨の Secret Manager で管理し、**secrets オプションに宣言した関数だけ**へ注入する
 * （値はコード・ビルド成果物・ログに残さない）。
 *   - 登録: `firebase functions:secrets:set MAKESHOP_ACCESS_TOKEN` / `MAKESHOP_API_KEY`
 *   - 非秘匿のエンドポイントURLは .env（MAKESHOP_API_ENDPOINT）で管理する（config/makeshop.ts）。
 *
 * どの関数に注入するか（最小権限）:
 *   - クーポン発行（createCoupon）を叩く関数だけに注入する。
 *     現状は adminTestIssueCoupon（1件テスト発行）。後続フェーズで受け取り者の発行関数にも注入する。
 */

import { defineSecret } from "firebase-functions/params";

/** MakeShop の固定アクセストークン（authorization: Bearer に載せる）。 */
export const MAKESHOP_ACCESS_TOKEN = defineSecret("MAKESHOP_ACCESS_TOKEN");

/** MakeShop の固定 APIキー（x-api-key に載せる）。 */
export const MAKESHOP_API_KEY = defineSecret("MAKESHOP_API_KEY");

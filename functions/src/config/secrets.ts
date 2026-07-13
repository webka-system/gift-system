/**
 * NE アプリの秘匿値（Secret Manager / defineSecret）
 *
 * client_id / client_secret は静的な秘匿値。Firebase の推奨に従い **Secret Manager** で管理し、
 * デプロイ時に該当関数へ注入する（値はコード・ビルド成果物・ログに残さない）。
 *   - 登録: `firebase functions:secrets:set NE_CLIENT_ID` / `NE_CLIENT_SECRET`
 *   - 利用: これらを **secrets オプションに宣言した関数だけ** に process.env として注入される。
 *
 * ★どの関数が必要か（最小権限）:
 *   - これらの秘匿値が要るのは **認証交換（/api_neauth）を行う neCallback / neCallbackTest だけ**。
 *     uid+state+client_id+client_secret で access_token/refresh_token を取得する初回フローに使う。
 *   - 受注アップロードやキュー確認など**通常のv1 API は access_token/refresh_token だけ**で動くため、
 *     onGiftCardConfirmed / adminRetryNeSubmissions には注入しない（＝秘匿値の露出面を最小化）。
 *
 * したがって isNeAutoConfigured（自動投入の可否）は client_id/secret には依存させない
 * （投入経路にこれらは不要。トークンが無ければ neApiCall がエラー→カードは pending に残る）。
 */

import { defineSecret } from "firebase-functions/params";

/** NE アプリのクライアントID（/api_neauth 交換専用）。 */
export const NE_CLIENT_ID = defineSecret("NE_CLIENT_ID");

/** NE アプリのクライアントシークレット（/api_neauth 交換専用）。 */
export const NE_CLIENT_SECRET = defineSecret("NE_CLIENT_SECRET");

/**
 * 受け取り者URLの組み立て（単一の生成点）
 *
 * QR にエンコードする URL と、フロントに案内する URL をここで一元生成する。
 * 形式は origin + TOKEN.URL_PREFIX + token（例: https://gift-system-f33b5.web.app/g/<token>）。
 * 受け取り者がスマホで読み取ると /g/<token> に着地する（firebase.json hosting rewrite）。
 */

import { TOKEN, CARD_KIND, DEFAULT_CARD_KIND } from "../config/constants";

/**
 * 受け取り者URLを組み立てる。origin は末尾スラッシュ無し前提（publicHostingOrigin が正規化）。
 * kind により接頭辞を切り替える（catalog=/g/ → 商品選択ページ / coupon=/gc/ → クーポン専用ページ）。
 * kind 未指定/未設定は catalog（後方互換＝従来どおり /g/）。
 */
export function buildCardUrl(origin: string, token: string, kind?: string): string {
  const prefix = (kind ?? DEFAULT_CARD_KIND) === CARD_KIND.COUPON
    ? TOKEN.COUPON_URL_PREFIX
    : TOKEN.URL_PREFIX;
  return `${origin}${prefix}${encodeURIComponent(token)}`;
}

/**
 * 受け取り者URLの組み立て（単一の生成点）
 *
 * QR にエンコードする URL と、フロントに案内する URL をここで一元生成する。
 * 形式は origin + TOKEN.URL_PREFIX + token（例: https://gift-system-f33b5.web.app/g/<token>）。
 * 受け取り者がスマホで読み取ると /g/<token> に着地する（firebase.json hosting rewrite）。
 */

import { TOKEN } from "../config/constants";

/** 受け取り者URLを組み立てる。origin は末尾スラッシュ無し前提（publicHostingOrigin が正規化）。 */
export function buildCardUrl(origin: string, token: string): string {
  return `${origin}${TOKEN.URL_PREFIX}${encodeURIComponent(token)}`;
}

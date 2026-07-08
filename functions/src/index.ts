/**
 * gift-system Cloud Functions エントリポイント
 * （TypeScript / 2nd gen functions = firebase-functions/v2 / Node.js 22）
 *
 * 役割:
 *   各機能モジュールが公開する関数トリガーをここから再エクスポートし、
 *   Firebase デプロイの入口とする。
 *
 * 設計ルール（docs/design.md）:
 *   - リージョンは asia-northeast1（東京）で統一（shared/constants.js REGION）。
 *   - 受け取り者(giftCards の使用)はクライアント直アクセス禁止。Functions 経由でのみ扱う
 *     （firestore.rules 参照 / トークン照合はサーバ側の関門）。
 *   - 文字列・列挙（コレクション名・ステータス・トークン仕様）は shared/constants.js を参照（ベタ書き禁止）。
 *
 * 現状: 雛形のみ。実装フェーズで各機能の関数をここに公開する。
 *
 * 例（実装後にコメントを外して公開する想定）:
 *   // 受け取り者: トークンでカードを引く（種別・商品ラインナップを返す）。
 *   // export { receiveGetCard } from "./http/receive";
 *   // 受け取り者: 商品選択＋住所確定 → 使用済み化 → NE投入(自動/CSV)。
 *   // export { receiveConfirm } from "./http/receive";
 *
 *   // 管理: QR一括生成 / 印刷用PDF出力。
 *   // export { adminGenerateQrCards, adminExportPrintPdf } from "./http/admin-qr";
 *
 *   // NE連携: 住所確定をトリガーに受注登録 / CSV出力。
 *   // export { neSubmitOrder, adminExportNeCsv } from "./http/ne";
 */

// デプロイ強制識別子。gen2 が「ソース不変」と誤判定して再デプロイを skip する事象への保険。
// 本番反映が疑わしいときは日付部を更新して再デプロイする（値自体はどこからも使わなくてよい）。
export const BUILD_ID = "2026-07-08-init-1";

// 管理API: QRコード一括生成（種別指定で任意個数・トークンはサーバ側生成 / design.md 4.1）。
// 認証：Firebase Auth IDトークン（requireAuth）。
export { adminGenerateGiftCards } from "./http/admin-qr";

/**
 * gift-system 共通定数（仕様の単一情報源 / Single Source of Truth）
 *
 * 設計書（docs/design.md）の値・列挙をここに集約する。
 * フロント（web/）・バックエンド（functions/）双方がこれを参照し、文字列のベタ書きを避ける。
 * 仕様変更があればここだけ直す。
 *
 * ※ ESM で書く。Hosting predeploy が web/shared/constants.js へコピーし、
 *   Functions は tsconfig の include（../shared/constants.js）経由でコンパイルして参照する。
 */

// ===== Firestore コレクション名（design.md 第3章）=====
export const COLLECTIONS = {
  GIFT_CARD_TYPES: "giftCardTypes",       // 3.1 ギフトカード種別（親）
  SELECTABLE_PRODUCTS: "selectableProducts", // 3.2 選定可能商品（子）
  GIFT_CARDS: "giftCards",                 // 3.3 発行済みQRカード
};

// ===== 発行済みQRカードのステータス（design.md 3.3）=====
export const CARD_STATUS = {
  UNUSED: "unused", // 未使用
  USED: "used",     // 使用済（受け取り者が確定 → 二重利用防止）
};

// ===== NE 投入状態（design.md 3.3 / 第6章）=====
// 「住所が確定した実商品受注のみ」を NE へ投入し、投入後にこの値を更新する。
// 状態遷移（自動）: pending → submitting → submitted（成功）/ pending（失敗時に戻す＝リトライ可能）
// 状態遷移（CSV） : pending → csv（CSV出力＝取込済み扱い）
export const NE_STATUS = {
  PENDING: "pending",       // 未投入（トリガー/CSVが拾う対象）
  SUBMITTING: "submitting", // 自動投入の処理中（claimによる二重投入防止の中間状態）
  SUBMITTED: "submitted",   // 自動連携で投入済（完了）
  CSV_EXPORTED: "csv",      // CSV出力済（手動/日次取込）
  ERROR: "error",           // 投入失敗（予約。当面は失敗時 pending に戻す運用）
};

// ===== NE 連携方式（design.md 第6章。自動・CSV の両対応）=====
export const NE_MODE = {
  AUTO: "auto", // Cloud Function から NE 受注登録 API を呼ぶ
  CSV: "csv",   // 確定済み受注を CSV 出力し手動/日次で取込
};

// ===== 受け取り者トークン =====
// 推測不可能なランダム値（外部アクセス制御の要 / design.md 第8章）。
// URL 形式は /g/<token> を想定（firebase.json hosting rewrites）。
export const TOKEN = {
  // 生成バイト数（base64url でおよそ 1.33 倍の文字数になる）。
  BYTES: 24,
  // URL パスの接頭辞。
  URL_PREFIX: "/g/",
};

// ===== QR 一括生成の上限（暴発防止のガード）=====
export const QR_GENERATION = {
  MAX_PER_BATCH: 1000, // 1回の一括生成で作れる最大枚数
};

// ===== Firestore / Storage ロケーション（design.md 第5章・第8章）=====
// ロケーションは変更不可のため東京で確定。
export const REGION = "asia-northeast1";

// ===== 印刷用PDF 面付けレイアウト（design.md 4.1「印刷用出力」/ 第9章 手順7）=====
// ★ 暫定値。最終的な正解は印刷工場の入稿仕様（カード実寸・面付け要否・トンボ/塗り足し・CMYK・
//   解像度）で決まる。工場仕様が判明したら **この定数を差し替えるだけ**で対応できるようにしてある。
//   初期値は標準的な A4縦・3列×4行=12枚/ページ・QR約40mm・各QR下にトークン文字。
//   QR解像度とクワイエットゾーンは読み取り信頼性を優先した値にしている。
export const PRINT = {
  // ページ寸法（mm）。既定 A4 縦。
  PAGE_W_MM: 210,
  PAGE_H_MM: 297,
  // ページ外周の余白（mm）。
  MARGIN_MM: 12,
  // 面付けグリッド（1ページ = COLUMNS × ROWS 枚）。
  COLUMNS: 3,
  ROWS: 4,
  // セル間のすき間（mm）。
  GUTTER_MM: 6,
  // QRコード1辺の仕上がりサイズ（mm）。読み取り優先の標準値。
  QR_SIZE_MM: 40,
  // 各QRの下にトークン文字を印字するか（目視突合用）。
  SHOW_TOKEN_LABEL: true,
  TOKEN_LABEL_PT: 7,
  // QRのクワイエットゾーン（周囲の余白）＝モジュール数。規格の最小は4。読み取り信頼性優先で4。
  QR_QUIET_ZONE_MODULES: 4,
  // QR画像のレンダリング解像度（dpi）。入稿・印刷のかすれに耐えるよう高め。
  QR_RENDER_DPI: 600,
  // 誤り訂正レベル（L=7% / M=15% / Q=25% / H=30%）。印刷のかすれ耐性を優先して Q。
  QR_ERROR_CORRECTION: "Q",
  // トンボ・塗り足し（工場入稿仕様が確定するまで既定は無効）。
  CROP_MARKS: false,
  BLEED_MM: 0,
  // 1回のPDF出力で扱う最大カード枚数（暴発・巨大生成の防止）。
  MAX_CARDS_PER_PDF: 2000,
};

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
export const NE_STATUS = {
  PENDING: "pending",       // 未投入
  SUBMITTED: "submitted",   // 自動連携で投入済
  CSV_EXPORTED: "csv",      // CSV出力済（手動/日次取込）
  ERROR: "error",           // 投入失敗（要リトライ）
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

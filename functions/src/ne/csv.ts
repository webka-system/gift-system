/**
 * NE 取込用 CSV の生成（design.md 第6章 / CSV連携）
 *
 * 文字コードは Shift_JIS（CP932）。NE の受注CSV取込は Shift_JIS 前提のことが多く、日本語の
 * 氏名・住所を安全に載せるため CP932 で出力する。
 *
 * ★★ 列構成は暫定（要 NE の受注CSV取込テンプレート）★★
 *   実際の列順・列名・必須項目は御社 NE 側の取込フォーマット設定に依存する。確定したら
 *   NE_CSV_COLUMNS を差し替える（buildNeCsvString はそのまま使える）。
 *
 * ★店舗（店舗2）の指定について:
 *   NE では「どの店舗の受注か」は **CSVの列では指定しない**。受注一括登録の**パターン（店舗2のパターン）**が
 *   店舗に紐づくため、この CSV は NE 取り込み時に「**店舗2の受注一括登録パターン**（NE_UPLOAD_PATTERN_ID）」を
 *   選んで取り込むこと。したがって本CSVに店舗列は持たせない（ファイル名 ne-orders-shop2.csv でも明示）。
 *
 * この層は純粋関数（Firestore/HTTP非依存）でテストしやすくしてある。
 */

import * as iconv from "iconv-lite";
import { NE_FIXED } from "../config/constants";
import { neDeliveryTime } from "./order";

/**
 * CSV 1行分の元データ（確定済み受注）。受注者＝発送先＝受け取り者なので、
 * 氏名・カナ・郵便番号・住所・電話は受注/発送の両ブロックで同じ値を使う。
 * 住所（address）は都道府県+市区町村番地+建物を結合済みの1文字列。
 */
export interface NeCsvRow {
  slipNo: string;       // 店舗伝票番号（token）
  orderDate: string;    // 受注日（usedAt を整形）
  name: string;         // 氏名（受注名＝発送先名）
  nameKana: string;     // 氏名カナ
  postalCode: string;   // 郵便番号
  address: string;      // 結合済み住所（都道府県+市区町村番地+建物）
  phone: string;        // 電話番号
  email: string;        // 受注メールアドレス
  productName: string;  // 商品名
  neProductCode: string; // 商品コード
  quantity: number;     // 受注数量（=1）
  deliveryDate: string; // 配達希望日（任意 / 空欄可）
  deliveryTime: string; // 配達希望時間帯（本システム表記。列側で NE 表記へ変換）
  cardTypeName: string; // 参考: カード種別（突合用）
  memo: string;         // 参考: 管理者memo（突合用）
}

/**
 * 列定義（ヘッダ表示名 → 値の取り出し）。§2 の NE 受注CSV項目に対応。
 * ★列順・列名は NE の汎用標準パターン設定に依存。確定したらここを差し替える。
 * 支払方法・発送方法・商品価格は固定値（NE_FIXED）。受注者ブロックと発送先ブロックは同値。
 */
export const NE_CSV_COLUMNS: { header: string; get: (r: NeCsvRow) => string | number }[] = [
  { header: "店舗伝票番号", get: (r) => r.slipNo },
  { header: "受注日", get: (r) => r.orderDate },
  { header: "受注名", get: (r) => r.name },
  { header: "受注名カナ", get: (r) => r.nameKana },
  { header: "受注郵便番号", get: (r) => r.postalCode },
  { header: "受注住所", get: (r) => r.address },
  { header: "受注電話番号", get: (r) => r.phone },
  { header: "受注メールアドレス", get: (r) => r.email },
  { header: "発送先名", get: (r) => r.name },
  { header: "発送先カナ", get: (r) => r.nameKana },
  { header: "発送郵便番号", get: (r) => r.postalCode },
  { header: "発送先住所", get: (r) => r.address },
  { header: "発送電話番号", get: (r) => r.phone },
  { header: "支払方法", get: () => NE_FIXED.PAYMENT_METHOD },
  { header: "発送方法", get: () => NE_FIXED.SHIPPING_METHOD },
  { header: "配達希望日", get: (r) => r.deliveryDate },
  { header: "配達希望時間帯", get: (r) => neDeliveryTime(r.deliveryTime) },
  { header: "商品名", get: (r) => r.productName },
  { header: "商品コード", get: (r) => r.neProductCode },
  { header: "商品価格", get: () => NE_FIXED.PRODUCT_PRICE },
  { header: "受注数量", get: (r) => r.quantity },
  { header: "カード種別", get: (r) => r.cardTypeName },
  { header: "memo", get: (r) => r.memo },
];

/** CSV フィールドのエスケープ（カンマ・引用符・改行を含む場合は "" で囲む）。 */
function csvField(v: string | number): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 行配列 → CSV 文字列（CRLF 区切り・ヘッダ付き）。 */
export function buildNeCsvString(rows: NeCsvRow[]): string {
  const lines: string[] = [];
  lines.push(NE_CSV_COLUMNS.map((c) => csvField(c.header)).join(","));
  for (const r of rows) {
    lines.push(NE_CSV_COLUMNS.map((c) => csvField(c.get(r))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** CSV 文字列 → Shift_JIS(CP932) バッファ。 */
export function toShiftJisBuffer(csv: string): Buffer {
  return iconv.encode(csv, "Shift_JIS");
}

/** 行配列 → Shift_JIS CSV バッファ（ワンショット）。 */
export function buildNeCsvBuffer(rows: NeCsvRow[]): Buffer {
  return toShiftJisBuffer(buildNeCsvString(rows));
}

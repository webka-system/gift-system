/**
 * NE 取込用 CSV の生成（design.md 第6章 / CSV連携）
 *
 * 文字コードは Shift_JIS（CP932）。NE の受注CSV取込は Shift_JIS 前提のことが多く、日本語の
 * 氏名・住所を安全に載せるため CP932 で出力する。
 *
 * ★列構成は NE 汎用パターンのサンプルCSVから確定（41列・順序・ヘッダー名を一字一句一致）★
 *   ヘッダー名が1つでも欠ける/違うと NE が「受注住所１が存在しません」等でエラーになるため、
 *   NE_CSV_COLUMNS の header 文字列は変更しないこと（全角「１」「２」「（%）」も正確に）。
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
 * 住所は住所1（都道府県+市区町村番地）と住所2（建物）に分ける。郵便番号・電話は数字のみ。
 */
export interface NeCsvRow {
  slipNo: string;        // 店舗伝票番号（token）
  orderDate: string;     // 受注日（yyyy/MM/dd HH:mm:ss）
  postalCode: string;    // 郵便番号（ハイフンなし数字）
  address1: string;      // 住所1（都道府県+市区町村番地）※必須。空にしない
  address2: string;      // 住所2（建物名・部屋番号）
  name: string;          // 氏名（受注名＝発送先名）
  nameKana: string;      // 氏名カナ（全角カナ）
  phone: string;         // 電話番号（ハイフンなし数字）
  email: string;         // メールアドレス
  productName: string;   // 商品名
  neProductCode: string; // 商品コード
  deliveryDate: string;  // 日付指定（yyyy/MM/dd。未指定は空）
  deliveryTime: string;  // 配達希望時間帯（本システム表記。列側で「時間帯指定[○○]」へ整形）
  memo: string;          // 備考（管理者memo。突合用・任意）
}

/**
 * NE 汎用パターンが期待する CSV の列定義（41列・この順序・ヘッダー名は一字一句一致）。
 * サンプルCSVから確定。受注ブロックと発送先ブロックは同一人物（受け取り者）の値を複製。
 * 金額系は 0 円方針（支払い済みギフト）。固定値は NE_FIXED。空欄列は "" を出す。
 * ★支払方法/発送方法/時間帯の正確な表記は実接続時に要確認（NE_FIXED / NE_DELIVERY_TIME_MAP）。
 */
export const NE_CSV_COLUMNS: { header: string; get: (r: NeCsvRow) => string | number }[] = [
  { header: "店舗伝票番号", get: (r) => r.slipNo },
  { header: "受注日", get: (r) => r.orderDate },
  { header: "受注郵便番号", get: (r) => r.postalCode },
  { header: "受注住所１", get: (r) => r.address1 },
  { header: "受注住所２", get: (r) => r.address2 },
  { header: "受注名", get: (r) => r.name },
  { header: "受注名カナ", get: (r) => r.nameKana },
  { header: "受注電話番号", get: (r) => r.phone },
  { header: "受注メールアドレス", get: (r) => r.email },
  { header: "発送郵便番号", get: (r) => r.postalCode },
  { header: "発送先住所１", get: (r) => r.address1 },
  { header: "発送先住所２", get: (r) => r.address2 },
  { header: "発送先名", get: (r) => r.name },
  { header: "発送先カナ", get: (r) => r.nameKana },
  { header: "発送電話番号", get: (r) => r.phone },
  { header: "支払方法", get: () => NE_FIXED.PAYMENT_METHOD },
  { header: "発送方法", get: () => NE_FIXED.SHIPPING_METHOD },
  { header: "商品計", get: () => 0 },
  { header: "税金", get: () => 0 },
  { header: "発送料", get: () => 0 },
  { header: "手数料", get: () => 0 },
  { header: "ポイント", get: () => 0 },
  { header: "その他費用", get: () => 0 },
  { header: "合計金額", get: () => 0 },
  { header: "ギフトフラグ", get: () => 0 },
  { header: "時間帯指定", get: (r) => (r.deliveryTime ? `時間帯指定[${neDeliveryTime(r.deliveryTime)}]` : "") },
  { header: "日付指定", get: (r) => r.deliveryDate },
  { header: "作業者欄", get: () => "" },
  { header: "備考", get: (r) => r.memo },
  { header: "商品名", get: (r) => r.productName },
  { header: "商品コード", get: (r) => r.neProductCode },
  { header: "商品価格", get: () => NE_FIXED.PRODUCT_PRICE },
  { header: "受注数量", get: () => NE_FIXED.QUANTITY },
  { header: "商品オプション", get: () => "" },
  { header: "出荷済フラグ", get: () => "" },
  { header: "顧客区分", get: () => "" },
  { header: "顧客コード", get: () => "" },
  { header: "消費税率（%）", get: () => "" },
  { header: "のし", get: () => "" },
  { header: "ラッピング", get: () => "" },
  { header: "メッセージ", get: () => "" },
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

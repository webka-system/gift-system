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
 * この層は純粋関数（Firestore/HTTP非依存）でテストしやすくしてある。
 */

import * as iconv from "iconv-lite";

/** CSV 1行分の元データ（確定済み受注）。 */
export interface NeCsvRow {
  token: string;
  cardTypeName: string;
  productName: string;
  neProductCode: string;
  quantity: number;
  name: string;
  postalCode: string;
  prefecture: string;
  address: string;
  building: string;
  phone: string;
  usedAt: string; // ISO or 表示用文字列
  memo: string;
}

/** 列定義（ヘッダ表示名 → 値の取り出し）。★NEテンプレ確定時にここを差し替える。 */
export const NE_CSV_COLUMNS: { header: string; get: (r: NeCsvRow) => string | number }[] = [
  { header: "商品コード", get: (r) => r.neProductCode },
  { header: "商品名", get: (r) => r.productName },
  { header: "数量", get: (r) => r.quantity },
  { header: "送り先氏名", get: (r) => r.name },
  { header: "郵便番号", get: (r) => r.postalCode },
  { header: "都道府県", get: (r) => r.prefecture },
  { header: "住所", get: (r) => r.address },
  { header: "建物名", get: (r) => r.building },
  { header: "電話番号", get: (r) => r.phone },
  { header: "カード種別", get: (r) => r.cardTypeName },
  { header: "トークン", get: (r) => r.token },
  { header: "確定日時", get: (r) => r.usedAt },
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

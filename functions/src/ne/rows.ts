/**
 * 確定済みカード（GiftCardData）→ NE取込CSVの1行（NeCsvRow）への変換（共通化）
 *
 * ★ここを単一情報源にする理由: 管理画面のCSV出力（adminExportNeCsv）と、API自動投入（ne/upload.ts）が
 *   **完全に同じ行データ**を生成するようにするため。手動CSV取込で NE 登録成功が実証済みの形式を、
 *   API アップロードでもそのまま流用する（フォーマット起因のトラブルを避ける）。
 *
 * 住所の分け方（NE汎用41列の仕様に一致）:
 *   受注住所１ = 都道府県 + address（必須・空にしない）／受注住所２ = building。
 * 郵便番号・電話は数字のみ。受注日は usedAt を JST「yyyy/MM/dd HH:mm:ss」。配達希望日は yyyy/MM/dd。
 */

import { NeCsvRow } from "./csv";
import { buildSlipNo } from "./order";
import { GiftCardData } from "../models";

/** 受注日: Firestore Timestamp を JST の「yyyy/MM/dd HH:mm:ss」に整形（NEサンプル準拠）。 */
export function fmtJstDateTime(ts: unknown): string {
  const t = ts as { toMillis?: () => number } | undefined;
  if (!t || typeof t.toMillis !== "function") return "";
  const j = new Date(t.toMillis() + 9 * 60 * 60 * 1000); // JST
  const p = (n: number) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} `
    + `${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`;
}

/** 郵便番号・電話番号: 数字のみ（ハイフン等を除去）。 */
export function digitsOnly(s: string | undefined): string {
  return (s || "").replace(/[^0-9]/g, "");
}

/** 配達希望日: "YYYY-MM-DD" → "yyyy/MM/dd"（未指定は空）。 */
export function slashDate(s: string | undefined): string {
  return s ? s.replace(/-/g, "/") : "";
}

/** 商品参照（selectableProducts の必要フィールドのみ）。 */
export interface NeRowProduct {
  name?: string;
  neProductCode?: string;
}

/**
 * 確定済みカード1枚を NeCsvRow（CSV1行の元データ）へ変換する。
 * product は selectedProductId から解決した selectableProducts のデータ（未解決なら空表示）。
 */
export function giftCardToNeCsvRow(data: GiftCardData, product?: NeRowProduct): NeCsvRow {
  const a = data.shippingAddress;
  // 住所1＝都道府県＋市区町村番地（必須・空にしない）、住所2＝建物。
  const address1 = `${a?.prefecture || ""}${a?.address || ""}`;
  const address2 = a?.building || "";
  return {
    slipNo: buildSlipNo(data.token),        // 店舗伝票番号（NE_SLIP_PREFIX + token）
    orderDate: fmtJstDateTime(data.usedAt), // 受注日 yyyy/MM/dd HH:mm:ss（JST）
    postalCode: digitsOnly(a?.postalCode),  // ハイフンなし数字
    address1,
    address2,
    name: a?.name || "",
    nameKana: a?.nameKana || "",
    phone: digitsOnly(a?.phone),            // ハイフンなし数字
    email: data.recipientEmail || "",
    productName: product?.name || "",
    neProductCode: product?.neProductCode || "",
    deliveryDate: slashDate(data.deliveryDate), // yyyy/MM/dd（未指定は空）
    deliveryTime: data.deliveryTime || "",      // 列側で「時間帯指定[○○]」へ整形
    memo: data.memo || "",
  };
}

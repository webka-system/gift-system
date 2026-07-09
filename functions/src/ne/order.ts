/*
 * NE 受注登録の項目マッピング（design.md 第6章 / 確定したフォーム仕様）
 *
 * ★★ フィールド名は暫定（要 NE APIリファレンス）★★
 *   NE 受注登録API の**正確なフィールド名**とエンドポイントはマーチャントごとの NE 仕様書で確定する。
 *   確定したら NE_FIELD の右辺だけ差し替える（呼び出し側は変更不要）。
 *
 * 本システム側の確定事項（確定したフォーム仕様に準拠）:
 *   - NE の受注者＝発送先＝**受け取り者本人**。両ブロックを同じ受け取り者情報で埋める。
 *   - 店舗伝票番号 = NE_SLIP_PREFIX + token（token は推測不可能な一意文字列＝衝突しない。下記の注参照）。
 *   - 受注日 = usedAt（確定日時）。
 *   - 支払方法・発送方法・商品価格・数量は固定値（NE_FIXED）。商品価格=0（支払い済みギフト）。
 *   - 商品コード = selectableProducts.neProductCode／商品名 = selectableProducts.name。
 *   - 配達希望日/時間帯は任意（空欄可）。時間帯は NE 区分表記へ変換（NE_DELIVERY_TIME_MAP）。
 *   - 文字コードは CSV 側で Shift_JIS。
 *
 * ★店舗（店舗2）の指定について:
 *   NE では「どの店舗の受注か」は CSV の列では持たせない。受注登録API/一括登録の際に、店舗コード（NE_STORE_CODE=
 *   「2」仮置き）または店舗に紐づく受注一括登録パターンID（NE_UPLOAD_PATTERN_ID）を指定することで店舗が決まる。
 *   どちらで指定するか・パラメータ名は使用する NE API 仕様に依存するため、両方の枠を用意し実接続時に確定する。
 *   - API送信時: NE_FIELD.storeCode / NE_FIELD.uploadPatternId（要NE確認）で渡す。
 *   - CSV: 列は持たせない。NE 取り込み時に「店舗2の受注一括登録パターン」を選ぶ運用。
 *
 * ★店舗伝票番号（token）の一意性について:
 *   token は base64url の推測不可能な一意文字列（TOKEN.BYTES 由来）。店舗2 の他の受注（MakeShop実受注は
 *   通常は連番等の数値ID）とは形式も値域も異なり、衝突しない。origin を明示したい場合は NE_SLIP_PREFIX に
 *   接頭辞（例 "GC-"）を設定できる（既定は空＝token そのまま。NE 側の桁数制限に注意）。
 */

import { ShippingAddress } from "../models";
import { NE_FIXED, DELIVERY } from "../config/constants";
import { NE_STORE_CODE, NE_UPLOAD_PATTERN_ID } from "../config/env";

/**
 * 店舗伝票番号の接頭辞（既定は空＝token そのまま）。
 * gift-system 由来と分かるよう印を付けたい場合に設定する（例 "GC-"）。NE の桁数制限に注意。
 */
export const NE_SLIP_PREFIX = "";

/** 店舗伝票番号を組み立てる（NE_SLIP_PREFIX + token）。 */
export function buildSlipNo(token: string): string {
  return `${NE_SLIP_PREFIX}${token}`;
}

/** NE 受注登録に渡す本システム側の入力（確定データ）。受注者＝発送先＝受け取り者。 */
export interface NeOrderInput {
  /** 店舗伝票番号に流用するカードのトークン。 */
  token: string;
  /** 受注日（usedAt を整形した文字列 "YYYY-MM-DD" 等）。 */
  orderDate: string;
  /** 実商品コード（selectableProducts.neProductCode）。 */
  neProductCode: string;
  /** 商品名（selectableProducts.name）。 */
  productName: string;
  /** 数量（常に1）。 */
  quantity: number;
  /** 受け取り者の氏名・カナ・住所・電話（受注者＝発送先の両方に使う）。 */
  address: ShippingAddress;
  /** 受け取り者のメールアドレス（受注メールアドレス）。 */
  email: string;
  /** 配達希望日（任意 / "YYYY-MM-DD"）。 */
  deliveryDate?: string;
  /** 配達希望時間帯（任意 / DELIVERY.TIME_SLOTS のいずれか）。 */
  deliveryTime?: string;
}

/**
 * 本システムの時間帯表記 → NE の時間帯区分表記の対応表。
 * ★ 値（右辺）は暫定で本システム表記と同一。NE の時間帯区分が確定したら値を差し替える（TODO(NE)）。
 * SSOT（DELIVERY.TIME_SLOTS）から生成して取りこぼしを防ぐ。
 */
export const NE_DELIVERY_TIME_MAP: Record<string, string> =
  Object.fromEntries(DELIVERY.TIME_SLOTS.map((s) => [s, s]));

/** 配達希望時間帯を NE 表記へ変換（未指定・未知は空/そのまま）。 */
export function neDeliveryTime(slot?: string): string {
  if (!slot) return "";
  return NE_DELIVERY_TIME_MAP[slot] ?? slot;
}

/** 都道府県＋市区町村番地＋建物名を1つの住所文字列に結合する。 */
export function joinAddress(a: ShippingAddress): string {
  return [a.prefecture, a.address, a.building].filter(Boolean).join(" ");
}

/**
 * 本システムの項目 → NE 受注登録APIのフィールド名 の対応表。
 * ★ 右辺（NE側フィールド名）は暫定。NE API 仕様書で確定したら**ここだけ**直す。
 */
export const NE_FIELD = {
  // 取り込み先店舗の指定（＝店舗2）。CSVには持たせず、API送信時にこれで店舗が決まる。
  // 店舗コード指定か／受注一括登録パターンID指定かは NE API 仕様に依存。実接続時に不要な方を外す。
  storeCode: "shop_id",                                // TODO(NE): 店舗コード（店舗ID）。正確なパラメータ名は要確認。
  uploadPatternId: "receive_order_upload_pattern_id",  // TODO(NE): 受注一括登録パターンID。正確なパラメータ名は要確認。
  // 受注ヘッダ
  slipNo: "receiveorder_id_shop",                      // TODO(NE): 店舗伝票番号
  orderDate: "receiveorder_date",                      // TODO(NE): 受注日
  // 受注者ブロック（＝受け取り者）
  ordererName: "receiveorder_name",                    // TODO(NE): 受注名
  ordererKana: "receiveorder_kana",                    // TODO(NE): 受注名カナ
  ordererZip: "receiveorder_zip_code",                 // TODO(NE): 受注郵便番号
  ordererAddress: "receiveorder_address",              // TODO(NE): 受注住所
  ordererTel: "receiveorder_tel",                      // TODO(NE): 受注電話番号
  ordererMail: "receiveorder_mail_address",            // TODO(NE): 受注メールアドレス
  // 発送先ブロック（＝受け取り者）
  consigneeName: "receiveorder_delivery_name",         // TODO(NE): 発送先名
  consigneeKana: "receiveorder_delivery_kana",         // TODO(NE): 発送先カナ
  consigneeZip: "receiveorder_delivery_zip_code",      // TODO(NE): 発送郵便番号
  consigneeAddress: "receiveorder_delivery_address",   // TODO(NE): 発送先住所
  consigneeTel: "receiveorder_delivery_tel",           // TODO(NE): 発送電話番号
  // 支払・発送・配達希望
  paymentMethod: "receiveorder_payment_method_name",   // TODO(NE): 支払方法
  shippingMethod: "receiveorder_delivery_method_name", // TODO(NE): 発送方法
  deliveryDate: "receiveorder_delivery_hope_date",     // TODO(NE): 配達希望日
  deliveryTime: "receiveorder_delivery_hope_time",     // TODO(NE): 配達希望時間帯
  // 明細
  productCode: "receiveorder_row_goods_id",            // TODO(NE): 商品コード
  productName: "receiveorder_row_goods_name",          // TODO(NE): 商品名
  productPrice: "receiveorder_row_unit_price",         // TODO(NE): 商品価格
  quantity: "receiveorder_row_quantity",               // TODO(NE): 受注数量
} as const;

/**
 * NeOrderInput を NE API のフォームパラメータへ変換する（暫定マッピング）。
 * 受注者＝発送先＝受け取り者なので、同じ情報を両ブロックへ載せる。
 * ★ フィールド名確定までは実投入しない前提（isNeAutoConfigured が false）。
 */
export function buildOrderParams(input: NeOrderInput): Record<string, string | number> {
  const a = input.address;
  const addr = joinAddress(a);
  return {
    // 店舗2として登録するための店舗指定（API送信時に付与）。店舗コード or パターンIDのどちらを NE が使うかは
    // 実接続時に確定（不要な方は外す）。実接続前は storeCode="2"（仮）・uploadPatternId=""（未設定）。
    [NE_FIELD.storeCode]: NE_STORE_CODE,
    [NE_FIELD.uploadPatternId]: NE_UPLOAD_PATTERN_ID,
    [NE_FIELD.slipNo]: buildSlipNo(input.token),
    [NE_FIELD.orderDate]: input.orderDate,
    // 受注者ブロック（受け取り者）
    [NE_FIELD.ordererName]: a.name,
    [NE_FIELD.ordererKana]: a.nameKana,
    [NE_FIELD.ordererZip]: a.postalCode,
    [NE_FIELD.ordererAddress]: addr,
    [NE_FIELD.ordererTel]: a.phone,
    [NE_FIELD.ordererMail]: input.email,
    // 発送先ブロック（同一人物）
    [NE_FIELD.consigneeName]: a.name,
    [NE_FIELD.consigneeKana]: a.nameKana,
    [NE_FIELD.consigneeZip]: a.postalCode,
    [NE_FIELD.consigneeAddress]: addr,
    [NE_FIELD.consigneeTel]: a.phone,
    // 支払・発送・配達希望
    [NE_FIELD.paymentMethod]: NE_FIXED.PAYMENT_METHOD,
    [NE_FIELD.shippingMethod]: NE_FIXED.SHIPPING_METHOD,
    [NE_FIELD.deliveryDate]: input.deliveryDate || "",
    [NE_FIELD.deliveryTime]: neDeliveryTime(input.deliveryTime),
    // 明細（価格0・数量1の固定）
    [NE_FIELD.productCode]: input.neProductCode,
    [NE_FIELD.productName]: input.productName,
    [NE_FIELD.productPrice]: NE_FIXED.PRODUCT_PRICE,
    [NE_FIELD.quantity]: input.quantity,
  };
}

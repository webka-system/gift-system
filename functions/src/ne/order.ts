/**
 * NE 受注登録の項目マッピング（design.md 第6章）
 *
 * ★★ 未確定（要 NE APIリファレンス）★★
 *   NE の受注登録API に渡す **正確な項目コード（フィールド名）と受注登録エンドポイントのパス**は、
 *   マーチャントごとの NE API 仕様書で確定する。ここでは本システムの確定データ（商品コード・配送先住所・
 *   数量=常に1）を「どの NE フィールドへ載せるか」の対応表を1箇所に集約した骨組みを置く。
 *   実フィールド名が確定したら NE_FIELD の値だけを差し替える（呼び出し側は変更不要）。
 *
 * 本システム側の確定事項:
 *   - 数量は常に 1（1カード=1商品 / design.md 3.3）。
 *   - NE へ流す商品コードは selectableProducts.neProductCode。
 *   - 配送先は giftCards.shippingAddress（氏名/郵便番号/都道府県/住所/建物/電話）。
 */

import { ShippingAddress } from "../models";

/** NE 受注登録に渡す本システム側の入力（確定データ）。 */
export interface NeOrderInput {
  /** 突合用にカードのトークンを控えとして送る（NE側 memo 等へ）。 */
  token: string;
  /** 実商品コード（selectableProducts.neProductCode）。 */
  neProductCode: string;
  /** 数量（常に1）。 */
  quantity: number;
  /** 配送先住所。 */
  address: ShippingAddress;
}

/**
 * 本システムの項目 → NE 受注登録APIのフィールド名 の対応表。
 * ★ 右辺（NE側フィールド名）は暫定。NE API 仕様書で確定したら**ここだけ**直す。
 *   （例として NE の受注系で見られる命名を仮置き。実名は要確認。）
 */
export const NE_FIELD = {
  // 明細
  productCode: "receiveorder_row_goods_id",      // TODO(NE): 実商品コード
  quantity: "receiveorder_row_quantity",          // TODO(NE): 数量
  // 送り先
  consigneeName: "receiveorder_delivery_name",    // TODO(NE): 送り先氏名
  consigneeZip: "receiveorder_delivery_zip_code", // TODO(NE): 郵便番号
  consigneePref: "receiveorder_delivery_address1", // TODO(NE): 都道府県
  consigneeAddress: "receiveorder_delivery_address2", // TODO(NE): 市区町村・番地
  consigneeBuilding: "receiveorder_delivery_address3", // TODO(NE): 建物名
  consigneeTel: "receiveorder_delivery_tel",      // TODO(NE): 電話
  // 突合メモ
  memo: "receiveorder_memo",                       // TODO(NE): 備考/メモ
} as const;

/**
 * NeOrderInput を NE API のフォームパラメータへ変換する（暫定マッピング）。
 * ★ フィールド名確定までは実投入しない前提（isNeAutoConfigured が false）。
 */
export function buildOrderParams(input: NeOrderInput): Record<string, string | number> {
  const a = input.address;
  return {
    [NE_FIELD.productCode]: input.neProductCode,
    [NE_FIELD.quantity]: input.quantity,
    [NE_FIELD.consigneeName]: a.name,
    [NE_FIELD.consigneeZip]: a.postalCode,
    [NE_FIELD.consigneePref]: a.prefecture,
    [NE_FIELD.consigneeAddress]: a.address,
    [NE_FIELD.consigneeBuilding]: a.building || "",
    [NE_FIELD.consigneeTel]: a.phone,
    [NE_FIELD.memo]: `giftcard:${input.token}`,
  };
}

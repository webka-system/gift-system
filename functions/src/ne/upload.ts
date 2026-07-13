/**
 * 受注伝票アップロード（/api_v1_receiveorder_base/upload）への実送信
 *
 * ★方式（確定・実証済みCSVを流用）:
 *   手動取込で NE 登録成功が確認済みの **41列 Shift-JIS CSV** をそのまま data_1 に載せて POST する。
 *   店舗は receive_order_upload_pattern_id（＝店舗2のギフト用パターン 11）で決まる。
 *
 * ★NEの仕様（公式リファレンス）:
 *   - POST パラメータ: access_token(必須) / refresh_token / receive_order_upload_pattern_id(必須・数値) /
 *     data_type_1="csv"(必須) / data_1=CSVファイル内容(必須) / wait_flag(任意)。
 *   - data_1 は **Shift-JIS のバイト列**を form-urlencoded で載せる（percentEncodeBytes で符号化）。
 *   - **完全な非同期キュー方式**。レスポンスは result=success と **que_id** を返すだけ＝「キュー受付」であり
 *     「取り込み完了」ではない。取り込み結果は ne/que.ts（/api_v1_system_que/search）で que_id を照会して確認する。
 */

import { NeCallDeps, neApiUpload } from "./client";
import { neConfig } from "../config/env";
import { NeCsvRow, buildNeCsvBuffer } from "./csv";

/** アップロードAPIのパラメータ名（公式リファレンス準拠）。 */
export const NE_UPLOAD_FIELDS = {
  patternId: "receive_order_upload_pattern_id", // 受注一括登録パターンID（=11 / 店舗2 gift用）
  dataType1: "data_type_1",                     // "csv"（GZIP時は "gz"）
  data1: "data_1",                              // 受注CSVファイル内容（Shift-JIS バイト列）
  waitFlag: "wait_flag",                        // "1"=過負荷でも極力エラーにせず実行
} as const;

/** アップロード結果（受付）。que_id はキュー確認（ne/que.ts）で使う。 */
export interface NeUploadResult {
  /** アップロードキューID。取り込み結果の確認に使う。 */
  queId: string;
}

/**
 * 確定済みの CSV 行を NE 受注伝票アップロードAPIへ送信する（非同期キューに受け付けさせる）。
 *   - uploadPatternId は neConfig().uploadPatternId（未設定なら呼び出し側の isNeAutoConfigured で弾かれている前提）。
 *   - 成功時は que_id を返す（取り込みの成否はまだ未確定＝ne/que.ts で確認する）。
 *   - result!=="success" は neApiUpload が NeApiError を投げる。
 */
export async function uploadNeCsvRows(rows: NeCsvRow[], deps: NeCallDeps = {}): Promise<NeUploadResult> {
  const cfg = neConfig();
  const csvBuffer = buildNeCsvBuffer(rows); // 41列・Shift-JIS（実証済み形式）
  const params: Record<string, string | number> = {
    [NE_UPLOAD_FIELDS.patternId]: cfg.uploadPatternId,
    [NE_UPLOAD_FIELDS.dataType1]: "csv",
    [NE_UPLOAD_FIELDS.waitFlag]: cfg.waitFlag,
  };
  const res = await neApiUpload(cfg.uploadEndpoint, params, NE_UPLOAD_FIELDS.data1, csvBuffer, deps);
  const queId = res.que_id != null ? String(res.que_id) : "";
  return { queId };
}

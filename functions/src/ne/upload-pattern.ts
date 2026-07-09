/*
 * 受注一括登録パターンID の特定（＝店舗2のパターンID を動的に求める）
 *
 * ★NEリファレンス調査で確定した段取り（実接続は審査通過後。ここは枠＝スタブ）:
 *   ① トークン取得（既存の neApiCall がトークンローテーションを担う）
 *   ② 受注一括登録パターン情報取得API /api_v1_receiveorder_uploadpattern/info を叩く
 *   ③ レスポンスから receive_order_upload_pattern_shop_id = 2（= NE_STORE_CODE / 店舗2）のパターンを見つけ、
 *      その receive_order_upload_pattern_id を取り出す
 *   ④ それを NE_UPLOAD_PATTERN_ID に設定し、受注伝票アップロードAPI /api_v1_receiveorder_base/upload で店舗2に投入
 *
 * ★重要（NE公式回答）: 店舗コード「2」をそのまま receive_order_upload_pattern_id に決め打ちして動く保証はない。
 *   必ず info API を叩いて shop_id で照合し、パターンIDを動的に特定すること。
 *
 * ★紛らわしい3番号の区別:
 *   - receive_order_shop_id … 店舗コード（「2」）。照合キー。
 *   - receive_order_upload_pattern_id … アップロードに渡すパターンID。上記とは別番号。← これを求める。
 *   - フォーマットパターンID（汎用標準=90 等）… さらに別物。混同しない。
 *
 * 本ファイルは「審査後にすぐ繋げる」ための枠。実際の照合ロジックは実装済みだが、実 API 呼び出しは
 * neApiCall（client/secret・トークンが揃って初めて動作）に委ねているため、設定が揃うまで実送信は発生しない。
 */

import { logger } from "firebase-functions/v2";
import { neApiCall, NeCallDeps } from "./client";

/** 受注一括登録パターン情報取得API のパス。 */
export const NE_UPLOAD_PATTERN_INFO_PATH = "/api_v1_receiveorder_uploadpattern/info";

/** info API のレスポンス行で使うフィールド名（要求フィールドにも指定する）。 */
export const NE_UPLOAD_PATTERN_FIELDS = {
  id: "receive_order_upload_pattern_id",           // パターンID（求める値）
  name: "receive_order_upload_pattern_name",       // パターン名（参考）
  shopId: "receive_order_upload_pattern_shop_id",  // 店舗ID（照合キー＝NE_STORE_CODE と突合）
} as const;

/** info API レスポンスの1行（必要フィールドのみ）。 */
export interface NeUploadPatternRow {
  receive_order_upload_pattern_id?: string;
  receive_order_upload_pattern_name?: string;
  receive_order_upload_pattern_shop_id?: string;
  [k: string]: unknown;
}

/**
 * 店舗ID（店舗コード）に紐づく受注一括登録パターンIDを特定する。
 *   - info API を叩き、receive_order_upload_pattern_shop_id === shopId のパターンを探して id を返す。
 *   - 見つからなければ null（呼び出し側で「パターン未特定」を扱う）。
 *
 * ★実接続は審査後。client_id/secret・トークンが未設定のうちは neApiCall が失敗するため、実送信は起きない。
 *   審査後は本関数の戻り値を NE_UPLOAD_PATTERN_ID に設定して buildOrderParams / アップロードで使う。
 */
export async function resolveUploadPatternId(
  shopId: string,
  deps: NeCallDeps = {},
): Promise<string | null> {
  const F = NE_UPLOAD_PATTERN_FIELDS;
  const res = await neApiCall(
    NE_UPLOAD_PATTERN_INFO_PATH,
    { fields: [F.id, F.name, F.shopId].join(",") },
    deps,
  );
  // NE の一覧系レスポンスは data 配列に行が入る想定。
  const rows = Array.isArray((res as { data?: unknown }).data)
    ? ((res as { data: NeUploadPatternRow[] }).data)
    : [];
  const hit = rows.find((r) => String(r[F.shopId] ?? "") === String(shopId));
  const patternId = hit?.[F.id] ? String(hit[F.id]) : null;
  logger.info("resolveUploadPatternId", { shopId, found: !!patternId, patternName: hit?.[F.name] ?? null });
  return patternId;
}

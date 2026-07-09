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
 * ★GAS実測で判明した確定値（既存のNE連携済GASで info API を実際に叩いた結果 / 2026-07-09）:
 *   - 店舗ID:2（makeshop）の受注一括登録パターンID = **4**（＝ resolveUploadPatternId("2") が返すべき値。検算用）。
 *     パターン名「九州お取り寄せ本舗(makeshop)(ネクストエンジンカート)」、フォーマットID:100035。
 *   - gift-system は店舗2に **パターンID:4** で投入する（月次集計の都合で店舗2確定）。
 *
 * ★実接続時の要確認①（無効パターン）: GAS実測時点で店舗2のパターン4は **deleted_flag が「無効」**だった
 *   （会社は普段API自動連携で取込しており、手動アップロード用パターンを使っていないため）。
 *   NE仕様上、無効/存在しないパターンIDをアップロードAPIに渡すと「存在しない受注一括登録パターン」エラーで
 *   弾かれる可能性がある。→ 実接続でアップロードが弾かれたら、**NE管理画面で店舗2の受注一括登録パターンを有効化**する。
 *   本関数は下記のとおり **有効パターン（deleted_flag が無効でないもの）だけに絞って**照合する（無効を掴まない）。
 *
 * ★実接続時の要確認②（フォーマット適合）: パターン4のフォーマットは「ネクストエンジンカート形式(100035)」で
 *   makeshop実受注用の形式。gift-system のマッピング（汎用フォーマット前提で構築）がこの100035形式と噛み合うかは
 *   実接続時に要確認。合わない場合は「店舗2に汎用フォーマット(90)の受注一括登録パターンを新規作成し、そのIDを使う
 *   （店舗2のまま、フォーマットだけ汎用にする）」を選択肢とする（docs/progress.md 参照）。
 *
 * ★紛らわしい3番号の区別:
 *   - receive_order_shop_id … 店舗コード（「2」）。照合キー。
 *   - receive_order_upload_pattern_id … アップロードに渡すパターンID（店舗2は=4）。上記とは別番号。← これを求める。
 *   - フォーマットパターンID（汎用標準=90 / パターン4は100035）… さらに別物。混同しない。
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
  id: "receive_order_upload_pattern_id",                 // パターンID（求める値）
  name: "receive_order_upload_pattern_name",             // パターン名（参考）
  shopId: "receive_order_upload_pattern_shop_id",        // 店舗ID（照合キー＝NE_STORE_CODE と突合）
  deletedFlag: "receive_order_upload_pattern_deleted_flag", // 無効フラグ（"1"=無効。有効のみに絞る）
} as const;

/** 店舗2（makeshop）の既知パターンID（GAS実測 / 検算・フォールバック用）。 */
export const NE_KNOWN_PATTERN_ID_SHOP2 = "4";

/** info API レスポンスの1行（必要フィールドのみ）。 */
export interface NeUploadPatternRow {
  receive_order_upload_pattern_id?: string;
  receive_order_upload_pattern_name?: string;
  receive_order_upload_pattern_shop_id?: string;
  receive_order_upload_pattern_deleted_flag?: string;
  [k: string]: unknown;
}

/** パターン行が有効か（deleted_flag が "1" でない）。無効パターンをアップロードに使うと弾かれるため除外する。 */
function isActivePattern(r: NeUploadPatternRow): boolean {
  return String(r[NE_UPLOAD_PATTERN_FIELDS.deletedFlag] ?? "") !== "1";
}

/**
 * 店舗ID（店舗コード）に紐づく **有効な** 受注一括登録パターンIDを特定する。
 *   - info API を叩き、deleted_flag が無効でない行のうち receive_order_upload_pattern_shop_id === shopId を探して id を返す。
 *   - 見つからなければ null（呼び出し側で「パターン未特定/無効」を扱う）。
 *   - 店舗2は既知値 NE_KNOWN_PATTERN_ID_SHOP2("4") と一致するはず（検算に使える）。
 *
 * ★無効パターン注意: 該当パターンが deleted_flag=無効だと有効行として拾えず null になる。その場合は NE 管理画面で
 *   店舗2の受注一括登録パターンを有効化する必要がある（無効/存在しないIDでアップロードすると弾かれるため）。
 * ★実接続は審査後。client_id/secret・トークンが未設定のうちは neApiCall が失敗するため、実送信は起きない。
 */
export async function resolveUploadPatternId(
  shopId: string,
  deps: NeCallDeps = {},
): Promise<string | null> {
  const F = NE_UPLOAD_PATTERN_FIELDS;
  const res = await neApiCall(
    NE_UPLOAD_PATTERN_INFO_PATH,
    { fields: [F.id, F.name, F.shopId, F.deletedFlag].join(",") },
    deps,
  );
  // NE の一覧系レスポンスは data 配列に行が入る想定。
  const rows = Array.isArray((res as { data?: unknown }).data)
    ? ((res as { data: NeUploadPatternRow[] }).data)
    : [];
  const shopRows = rows.filter((r) => String(r[F.shopId] ?? "") === String(shopId));
  const activeHit = shopRows.find(isActivePattern);
  const patternId = activeHit?.[F.id] ? String(activeHit[F.id]) : null;
  // 該当店舗のパターンはあるが全て無効（deleted_flag=1）のケースを検知して警告（有効化が必要）。
  const hasInactiveOnly = !activeHit && shopRows.length > 0;
  logger.info("resolveUploadPatternId", {
    shopId,
    found: !!patternId,
    patternName: activeHit?.[F.name] ?? null,
    hasInactiveOnly, // true の場合は NE 管理画面で当該パターンの有効化が必要。
  });
  return patternId;
}

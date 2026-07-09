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
 * ★店舗2には現在2つの受注一括登録パターンがある（GAS実測＋新規作成 / 2026-07-09）:
 *   - パターンID:4 … 名前「九州お取り寄せ本舗(makeshop)(ネクストエンジンカート)」/ フォーマットID:100035
 *     （= makeshop の**実受注取込用**。gift-system用ではない。使わない）。
 *   - パターンID:11 … 名前「九州お取り寄せ本舗(makeshop扱い ギフトカード)」/ フォーマットID:**90（汎用標準）**
 *     （= gift-system の**カタログギフト用に新規作成**したパターン。現在「無効」）。
 *   → **gift-system は店舗2にパターンID:11 で投入する**。フォーマット90（汎用）なので gift-system の CSV マッピング
 *     （汎用前提）と整合し、0.11 で記録した「100035形式が合わなければ汎用90パターンを新規作成」の対処が実現済み。
 *   → resolveUploadPatternId("2") は複数パターンから gift 用を選ぶ必要があるため、**名前に「ギフトカード」を含む**
 *     （NE_GIFT_PATTERN_NAME_HINT）で絞り込む。検算値は NE_KNOWN_PATTERN_ID_SHOP2 = "11"。
 *
 * ★実接続時の要確認①（無効パターン→有効化が必須）: パターン11は現在 **deleted_flag が「無効」**。
 *   無効/存在しないパターンIDをアップロードAPIに渡すと「存在しない受注一括登録パターン」エラーで弾かれる。
 *   → **実接続前に NE 管理画面で店舗2のパターン11（ギフトカード）を有効化**すること。
 *   本関数は **有効パターン（deleted_flag が無効でないもの）だけに絞って**照合するため、11が無効のままだと null を返す
 *   （＝有効化が必要のサイン）。
 *
 * ★実接続時の要確認②（フォーマット適合）: パターン11はフォーマット90（汎用標準）なので gift-system の汎用前提
 *   マッピングと噛み合う想定。実 CSV/APIで区分変換警告等が出ないかは実接続時に最終確認。
 *
 * ★紛らわしい3番号の区別:
 *   - receive_order_shop_id … 店舗コード（「2」）。照合キー。
 *   - receive_order_upload_pattern_id … アップロードに渡すパターンID（gift用=11）。上記とは別番号。← これを求める。
 *   - フォーマットパターンID（汎用標準=90 / makeshop実受注のパターン4は100035）… さらに別物。混同しない。
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

/** 店舗2のギフトカード用パターンID（新規作成・フォーマット90/汎用・現在無効）。検算・フォールバック用。 */
export const NE_KNOWN_PATTERN_ID_SHOP2 = "11";

/** 店舗2に複数パターンがある場合に gift 用を選ぶための名前絞り込みキー。 */
export const NE_GIFT_PATTERN_NAME_HINT = "ギフトカード";

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
 *   - opts.nameContains を渡すと、さらにパターン名にその文字列を含む行だけに絞る（店舗2に複数パターンがある場合の
 *     gift 用の選別。gift-system は nameContains=NE_GIFT_PATTERN_NAME_HINT("ギフトカード") で呼ぶ想定）。
 *   - 見つからなければ null（呼び出し側で「パターン未特定/無効」を扱う）。
 *   - 店舗2の gift 用は既知値 NE_KNOWN_PATTERN_ID_SHOP2("11") と一致するはず（検算に使える）。
 *
 * ★無効パターン注意: 該当パターンが deleted_flag=無効だと有効行として拾えず null になる。その場合は NE 管理画面で
 *   店舗2の受注一括登録パターン（ギフトカード=11）を有効化する必要がある（無効/存在しないIDでアップロードすると弾かれる）。
 * ★実接続は審査後。client_id/secret・トークンが未設定のうちは neApiCall が失敗するため、実送信は起きない。
 */
export async function resolveUploadPatternId(
  shopId: string,
  deps: NeCallDeps = {},
  opts: { nameContains?: string } = {},
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
  let shopRows = rows.filter((r) => String(r[F.shopId] ?? "") === String(shopId));
  // 店舗2に複数パターンがある場合は名前で gift 用に絞る（例「ギフトカード」）。
  if (opts.nameContains) {
    shopRows = shopRows.filter((r) => String(r[F.name] ?? "").includes(opts.nameContains as string));
  }
  const activeHit = shopRows.find(isActivePattern);
  const patternId = activeHit?.[F.id] ? String(activeHit[F.id]) : null;
  // 該当（名前絞り込み後）のパターンはあるが全て無効（deleted_flag=1）のケースを検知して警告（有効化が必要）。
  const hasInactiveOnly = !activeHit && shopRows.length > 0;
  logger.info("resolveUploadPatternId", {
    shopId,
    found: !!patternId,
    patternName: activeHit?.[F.name] ?? null,
    hasInactiveOnly, // true の場合は NE 管理画面で当該パターンの有効化が必要。
  });
  return patternId;
}

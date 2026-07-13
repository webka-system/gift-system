/*
 * 有効期限の判定（受け取り者確定・管理画面で共有する単一情報源 / 環境非依存の純粋関数）
 *
 * 方針（design.md 拡張 / 確定仕様）:
 *   - 基準は生成日 generatedAt。generatedAt + 有効日数 が有効期限。
 *   - 有効日数は「個別カードの上書き（expiryDaysOverride）> 種別のデフォルト（expiryDays）」の優先で解決。
 *   - **後方互換（安全側）**: 有効日数が未設定（種別に expiryDays 無し・上書きも無し）、または generatedAt が
 *     不明なカードは「無期限」＝期限切れにしない。既存カードを遡って無効化しないための選択。
 *   - ブラウザ（受け取り者・管理画面）と Cloud Functions（サーバ判定）の双方から import する。ルールがずれないよう
 *     ここを唯一の実装とする。時刻はミリ秒（Date.now() / Timestamp.toMillis()）で受け渡し、タイムゾーン非依存。
 */

/** 「期限が近い」の残り日数しきい値（管理画面の絞り込み・表示に使用）。 */
export const EXPIRY_NEAR_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 有効日数を解決（個別上書き > 種別デフォルト）。正の整数のみ有効。無ければ null（＝無期限）。 */
export function resolveExpiryDays(overrideDays, typeDays) {
  const ok = (v) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  const o = ok(overrideDays);
  return o !== null ? o : ok(typeDays);
}

/** 有効期限のミリ秒（generatedAtMs + 有効日数）。算出不能・無期限は null。 */
export function expiryMillis(generatedAtMs, expiryDays) {
  if (typeof generatedAtMs !== "number" || !Number.isFinite(generatedAtMs)) return null;
  if (expiryDays == null) return null;
  return generatedAtMs + expiryDays * DAY_MS;
}

/**
 * 期限の判定結果を返す。
 * @param {{generatedAtMs?:number, overrideDays?:number, typeDays?:number, nowMs:number}} args
 * @returns {{hasExpiry:boolean, expiryMs:(number|null), expired:boolean, remainingDays:(number|null), near:boolean}}
 */
export function expiryInfo({ generatedAtMs, overrideDays, typeDays, nowMs }) {
  const days = resolveExpiryDays(overrideDays, typeDays);
  const expiryMs = expiryMillis(generatedAtMs, days);
  if (expiryMs == null) {
    return { hasExpiry: false, expiryMs: null, expired: false, remainingDays: null, near: false };
  }
  const now = typeof nowMs === "number" ? nowMs : 0;
  const expired = now > expiryMs;
  const remainingDays = Math.ceil((expiryMs - now) / DAY_MS);
  const near = !expired && remainingDays <= EXPIRY_NEAR_DAYS;
  return { hasExpiry: true, expiryMs, expired, remainingDays, near };
}

/*
 * 配達希望日の選択可能範囲（純粋・環境非依存 / design.md 4.2）
 *
 * 受け取り者(client)・単体テストで共有する。shared/constants.js（DELIVERY.MIN_DAYS/MAX_MONTHS）には
 * 依存させず、日数・月数は呼び出し側から渡す（環境非依存・テスト容易のため。shared/expiry.js と同じ方針）。
 *
 * ★iOS Safari の <input type="date"> は min/max 属性を無視して全期間を選べてしまう（既知の挙動）。
 *   そのためクライアントでもこのロジックで範囲外を弾く「保険」にする。
 *   サーバ(receiveConfirm / order-fields)の JST 検証が最終防衛線であることは変えない（クライアントは体験改善）。
 */

/** Date → "YYYY-MM-DD"（ローカル日付）。 */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * now(ms) を起点に、選択可能な最小日(+minDays)・最大日(+maxMonths)を "YYYY-MM-DD" で返す。
 * 例: minDays=14, maxMonths=2 → 確定日の2週間先〜2か月以内。
 */
export function deliveryDateBounds(nowMs, minDays, maxMonths) {
  const min = new Date(nowMs); min.setDate(min.getDate() + minDays);
  const max = new Date(nowMs); max.setMonth(max.getMonth() + maxMonths);
  return { min: ymd(min), max: ymd(max) };
}

/**
 * ymdStr("YYYY-MM-DD") が選択可能範囲内か。
 * 空文字（未入力＝任意）は true（範囲チェック対象外＝指定なしで進める）。
 * 文字列 "YYYY-MM-DD" は辞書順比較＝日付順比較になるため、そのまま境界含む比較で判定できる。
 */
export function isDeliveryDateInRange(ymdStr, nowMs, minDays, maxMonths) {
  if (!ymdStr) return true;
  const { min, max } = deliveryDateBounds(nowMs, minDays, maxMonths);
  return ymdStr >= min && ymdStr <= max;
}

/** "YYYY-MM-DD" → "M月D日"（受け取り者向けの日本語表記。案内・エラー文で使う）。 */
export function ymdToJp(ymdStr) {
  const parts = String(ymdStr).split("-");
  if (parts.length !== 3) return String(ymdStr);
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

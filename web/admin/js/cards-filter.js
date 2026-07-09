/*
 * QR一覧のクライアント側フィルタ（グループC / 受注内容での検索・絞り込み）
 *
 * Firestore は部分一致検索が不得手なため、取得済みの一覧に対してブラウザ側で絞り込む。
 * DOM/Firebase 非依存の純粋関数にして、単体で検証できるようにしてある。
 */

/** トークン短縮表示（先頭8文字＋…）。全文は title 属性・詳細ビュー・URLコピーで参照できる。 */
export function shortToken(token) {
  const t = String(token || "");
  return t.length > 8 ? `${t.slice(0, 8)}…` : t;
}

/**
 * カードが検索語にヒットするか（小文字での部分一致）。
 * 対象: トークン・memo・メールアドレス・受け取り者名・氏名カナ。
 */
export function cardMatchesQuery(c, q) {
  if (!q) return true;
  const hay = [
    c.token, c.memo, c.recipientEmail,
    c.shippingAddress?.name, c.shippingAddress?.nameKana,
  ].filter(Boolean).join("\n").toLowerCase();
  return hay.includes(q);
}

// ロット（生成バッチ）絞り込みで「生成日時不明（batchId 無し）」を表す番兵値。
export const LOT_NONE = "__none__";

/**
 * NE投入状態＋ロット＋テキスト検索でカード配列を絞り込む。
 *   - neStatus: "" なら無条件。値があれば c.neStatus 完全一致（未使用カードは neStatus 無し＝除外）。
 *   - batchId: "" なら無条件。LOT_NONE なら batchId 無しの既存カード。値なら c.batchId 完全一致。
 *   - query: 前後空白除去＋小文字化して部分一致。
 */
export function filterCards(cards, { neStatus = "", batchId = "", query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  let rows = Array.isArray(cards) ? cards : [];
  if (neStatus) rows = rows.filter((c) => c.neStatus === neStatus);
  if (batchId) {
    rows = batchId === LOT_NONE
      ? rows.filter((c) => !c.batchId)
      : rows.filter((c) => c.batchId === batchId);
  }
  if (q) rows = rows.filter((c) => cardMatchesQuery(c, q));
  return rows;
}

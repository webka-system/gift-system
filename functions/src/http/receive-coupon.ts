/**
 * 受け取り者API（株主優待クーポン / kind=coupon 専用）
 *
 * ★既存のカタログ受け取り者フロー（receiveGetCard / receiveConfirm と /receive/index.html）には一切触れない。
 *   クーポンは別URL（/gc/<token> → /receive/coupon.html）＋別関数で振り分ける（カタログを壊さない）。
 *
 * エンドポイント:
 *   - GET  /api/receiveGetCoupon?token=...  … トークンでクーポンカードを引き、状態（発行済/未発行/期限切れ）＋
 *                                             種別の割引内容・有効期限・ECリンクを返す。副作用なし。
 *   - POST /api/receiveClaimCoupon          … 都度発行。未発行を検証して claim→MakeShop発行→issued 確定
 *                                             （二重発行防止は issueCouponForCard の claim トランザクション）。
 *
 * 認証: 受け取り者（株主）はログインしない。推測不可能なトークンが唯一のアクセス制御（design.md 第8章）。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { CARD_KIND, DEFAULT_CARD_KIND, COUPON_STATUS, COUPON } from "../config/constants";
import { HTTP_OPTIONS } from "./options";
import { giftCardsRef, giftCardTypesRef } from "../lib/firestore";
import { GiftCardData } from "../models";
import { applyCors } from "./cors";
import { MAKESHOP_ACCESS_TOKEN, MAKESHOP_API_KEY } from "../makeshop/secrets";
import { issueCouponForCard } from "../makeshop/issue";

// MakeShop 秘匿値は発行を行う receiveClaimCoupon にだけ注入する（GET には不要）。
const CLAIM_OPTIONS = { ...HTTP_OPTIONS, secrets: [MAKESHOP_ACCESS_TOKEN, MAKESHOP_API_KEY] };

function tokenOf(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function toMillis(ts: unknown): number | undefined {
  const t = ts as { toMillis?: () => number } | undefined;
  return t && typeof t.toMillis === "function" ? t.toMillis() : undefined;
}

/** couponConfig（割引方式・額）→ 表示文字列（例「10%OFF」「3,000円OFF」）。 */
function discountText(cfg: { discountType?: string; discountValue?: number } | undefined): string {
  if (!cfg || typeof cfg.discountValue !== "number") return "";
  if (cfg.discountType === COUPON.DISCOUNT_TYPE.RATE) return `${cfg.discountValue}%OFF`;
  return `${cfg.discountValue.toLocaleString("ja-JP")}円OFF`;
}

/** couponExpiryAt(ms) → 「2027年3月31日」（JST）。 */
function expiryText(ms: number | undefined): string {
  if (!ms) return "";
  const j = new Date(ms + 9 * 60 * 60 * 1000);
  return `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日`;
}

/** トークンでクーポンカードを引く（無ければ null）。kind!=coupon も null 扱い（このフローの対象外）。 */
async function findCouponCard(token: string): Promise<{ id: string; card: GiftCardData } | null> {
  const snap = await giftCardsRef.where("token", "==", token).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const card = doc.data();
  if ((card.kind ?? DEFAULT_CARD_KIND) !== CARD_KIND.COUPON) return null;
  return { id: doc.id, card };
}

/**
 * GET /api/receiveGetCoupon?token=...
 *   res(200): { ok:true, status:"issued"|"ready"|"issuing"|"expired",
 *              couponType:{ name, discountText }, expiryText, ecUrl,
 *              couponCode?（issued時）, issuedAtMs?（issued時） }
 *   res(404): { ok:false, code:"not_found" }（無効トークン / クーポンでない）
 */
export const receiveGetCoupon = onRequest(HTTP_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const token = tokenOf(req.query.token);
  if (!token) { res.status(400).json({ ok: false, code: "invalid_argument" }); return; }

  try {
    const found = await findCouponCard(token);
    if (!found) { res.status(404).json({ ok: false, code: "not_found" }); return; }
    const { card } = found;

    const typeSnap = await giftCardTypesRef.doc(String(card.cardTypeId)).get();
    const type = typeSnap.data();
    const expiryMs = toMillis(card.couponExpiryAt);
    const couponType = {
      name: type?.name ?? "株主優待クーポン",
      discountText: discountText(type?.couponConfig),
    };
    const common = { ok: true, couponType, expiryText: expiryText(expiryMs), ecUrl: COUPON.EC_URL };

    // 発行済みなら保存済みコードを返す（再アクセス＝APIを叩かない）。期限切れでも既発行コードは表示してよい。
    if (card.couponStatus === COUPON_STATUS.ISSUED && card.couponCode) {
      res.status(200).json({ ...common, status: "issued", couponCode: card.couponCode, issuedAtMs: toMillis(card.couponIssuedAt) });
      return;
    }
    // 期限切れ（未発行）は発行不可。
    if (expiryMs && Date.now() > expiryMs) {
      res.status(200).json({ ...common, status: "expired" });
      return;
    }
    // 発行処理中（別リクエストが claim 済み）。ページは少し待って再取得/再試行する。
    if (card.couponStatus === COUPON_STATUS.ISSUING) {
      res.status(200).json({ ...common, status: "issuing" });
      return;
    }
    // 未発行（初回 or 発行失敗して未使用に戻った）。ページが receiveClaimCoupon で発行する。
    res.status(200).json({ ...common, status: "ready" });
  } catch (err) {
    logger.error("receiveGetCoupon failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

/**
 * POST /api/receiveClaimCoupon   body: { token }
 *   res(200): { ok:true, status:"issued", couponCode } … 発行成功（または既発行）
 *           | { ok:true, status:"failed" }             … MakeShop発行失敗（未発行のまま・リトライ可）
 *           | { ok:true, status:"expired" }            … 有効期限切れ（発行不可）
 *           | { ok:true, status:"issuing" }            … 別リクエストが発行処理中
 *   res(404): { ok:false, code:"not_found" }
 *
 * 二重発行防止: issueCouponForCard がトランザクションで「未発行」を検証して issuing を確保してから発行する。
 * 失敗理由（MakeShop errorMessage）は couponLastError にサーバ側で記録（株主には汎用メッセージのみ返す）。
 */
export const receiveClaimCoupon = onRequest(CLAIM_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const body = (req.body ?? {}) as { token?: unknown };
  const token = tokenOf(body.token);
  if (!token) { res.status(400).json({ ok: false, code: "invalid_argument" }); return; }

  try {
    const found = await findCouponCard(token);
    if (!found) { res.status(404).json({ ok: false, code: "not_found" }); return; }

    const outcome = await issueCouponForCard(found.id);
    logger.info("receiveClaimCoupon", { result: outcome.result, reason: outcome.reason });

    if (outcome.result === "issued") {
      res.status(200).json({ ok: true, status: "issued", couponCode: outcome.couponCode });
      return;
    }
    if (outcome.reason === "expired") {
      res.status(200).json({ ok: true, status: "expired" });
      return;
    }
    if (outcome.reason === "issuing") {
      res.status(200).json({ ok: true, status: "issuing" });
      return;
    }
    // failed / already_used 等 → 未発行のまま。株主にはリトライ可能な失敗として返す（raw/理由は返さない）。
    res.status(200).json({ ok: true, status: "failed" });
  } catch (err) {
    logger.error("receiveClaimCoupon failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

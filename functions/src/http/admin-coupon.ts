/**
 * 管理API: クーポンの1件テスト発行（MakeShop 実接続の検証用）
 *
 * 受け取り者フローに繋ぐ前に、「クーポンカード1枚を指定して、実際に MakeShop へクーポンを1件発行してみる」
 * ための隔離した仕組み。発行→MakeShop管理画面で目視確認→エラーがあれば errorMessage を見て
 * coupon.ts のフィールド名/enum を実スキーマに直す、というサイクルを回す（introspection を省いた実証アプローチ）。
 *
 * 使い方:
 *   1) 管理画面でクーポン種別を作成 → クーポンQRを1枚生成（couponExpiryAt が入る）。
 *   2) そのカードの id を渡してこの API を叩く（POST { cardId }）。
 *   3) 成功なら status=used・couponStatus=issued・couponCode 保存。MakeShop 側にクーポンが作られる。
 *      失敗なら未使用のまま・couponLastError と raw に MakeShop の応答が入るので、それを見て直す。
 *
 * 認証: requireAuth（管理者のみ）。★MakeShop 秘匿値（Secret Manager）をこの関数にだけ注入する。
 *
 * ★新規HTTP関数のため、デプロイ後に **Cloud Run コンソールで手動「パブリックアクセスを許可」** が必要
 *   （組織ポリシーで allUsers 自動設定が失敗するため。SPECIFICATION 7.3 と同じ運用）。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { HTTP_OPTIONS } from "./options";
import { applyCors } from "./cors";
import { requireAuth } from "./guard";
import { isMakeshopConfigured } from "../config/makeshop";
import { MAKESHOP_ACCESS_TOKEN, MAKESHOP_API_KEY } from "../makeshop/secrets";
import { issueCouponForCard } from "../makeshop/issue";
import { introspectCouponSchema } from "../makeshop/introspect";

// MakeShop 秘匿値をこの関数にだけ注入する（最小権限）。
const COUPON_TEST_OPTIONS = { ...HTTP_OPTIONS, secrets: [MAKESHOP_ACCESS_TOKEN, MAKESHOP_API_KEY] };

/**
 * POST /api/adminTestIssueCoupon
 *   body: { cardId: string }
 *   res : { ok:true, result:"issued"|"failed"|"skipped", couponCode?, error?, reason?, raw? }
 *         | { ok:false, code, message? }
 *   ※ raw には MakeShop の生レスポンスを入れる（スキーマ調整のため失敗理由をそのまま見せる）。
 */
export const adminTestIssueCoupon = onRequest(COUPON_TEST_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  if (!isMakeshopConfigured()) {
    res.status(503).json({
      ok: false,
      code: "makeshop_not_configured",
      message: "MAKESHOP_API_ENDPOINT / MAKESHOP_ACCESS_TOKEN / MAKESHOP_API_KEY を設定してください。",
    });
    return;
  }

  const body = (req.body ?? {}) as { cardId?: unknown; introspect?: unknown };

  // introspect モード: 実スキーマ（CreateCouponRequest の inputFields・enum値・結果型）を取得して返す。
  // 推定を排除してフィールド名/enum/日付書式を確定させるための1回叩き（カード不要・発行しない）。
  if (body.introspect === true) {
    try {
      const schema = await introspectCouponSchema();
      logger.info("adminTestIssueCoupon introspect");
      res.status(200).json({ ok: true, mode: "introspect", raw: schema });
    } catch (err) {
      logger.error("introspect failed", { message: err instanceof Error ? err.message : "unknown" });
      res.status(500).json({ ok: false, code: "internal", message: err instanceof Error ? err.message : "unknown" });
    }
    return;
  }

  const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
  if (!cardId) { res.status(400).json({ ok: false, code: "invalid_argument", message: "cardId is required" }); return; }

  try {
    // 管理画面からの発行は「手動（再）発行」＝名前に【再発行 M/D】を付け、既発行カードも再発行できる。
    const outcome = await issueCouponForCard(cardId, { reissue: true });
    logger.info("adminTestIssueCoupon", { cardId, result: outcome.result, reason: outcome.reason });
    // 失敗/スキップでも HTTP 200 で返す（管理テストなので結果と raw を UI/ログで確認するため）。
    res.status(200).json({ ok: true, ...outcome });
  } catch (err) {
    logger.error("adminTestIssueCoupon failed", { cardId, message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal", message: err instanceof Error ? err.message : "unknown" });
  }
});

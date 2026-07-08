/**
 * 管理API: QRコード一括生成（design.md 4.1「QRコード一括生成」/ 第9章 手順6）
 *
 * ハイブリッド構成のうち **Cloud Functions 側**の責務:
 *   - トークンは推測不可能な値でなければならない（design.md 第8章）。生成はサーバ側でのみ行い、
 *     shared/constants.js のトークン仕様（TOKEN.BYTES）に準拠する（lib/token）。
 *   - 種別を指定して任意個数（1〜QR_GENERATION.MAX_PER_BATCH）の giftCards を一括作成する。
 *   - 生成時点は「まだ誰のものでもない空のカード」＝ status:unused / memo:"" のみ（design.md 3.3）。
 *
 * 認証: Firebase Auth IDトークン（requireAuth）。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { CARD_STATUS, QR_GENERATION } from "../config/constants";
import { HTTP_OPTIONS } from "./options";
import { db, giftCardsRef, giftCardTypesRef } from "../lib/firestore";
import { generateCardToken } from "../lib/token";
import { applyCors } from "./cors";
import { requireAuth } from "./guard";

// Firestore の一括書き込み（WriteBatch）は1回あたり最大500オペレーション。
// これを超える個数はチャンク分割して複数バッチで書く。
const BATCH_LIMIT = 500;

interface GenerateBody {
  cardTypeId?: unknown;
  count?: unknown;
}

/**
 * POST /api/adminGenerateGiftCards
 *   body: { cardTypeId: string, count: number }
 *   res : { ok: true, created: number } | { ok: false, code, message? }
 */
export const adminGenerateGiftCards = onRequest(HTTP_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, code: "method_not_allowed" });
    return;
  }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  const body = (req.body ?? {}) as GenerateBody;
  const cardTypeId = typeof body.cardTypeId === "string" ? body.cardTypeId.trim() : "";
  const count = typeof body.count === "number" ? Math.floor(body.count) : NaN;

  if (!cardTypeId) {
    res.status(400).json({ ok: false, code: "invalid_argument", message: "cardTypeId is required" });
    return;
  }
  if (!Number.isInteger(count) || count < 1 || count > QR_GENERATION.MAX_PER_BATCH) {
    res.status(400).json({
      ok: false,
      code: "invalid_argument",
      message: `count must be an integer between 1 and ${QR_GENERATION.MAX_PER_BATCH}`,
    });
    return;
  }

  // 種別の存在確認（存在しない種別のカードを作らない）。
  const typeSnap = await giftCardTypesRef.doc(cardTypeId).get();
  if (!typeSnap.exists) {
    res.status(404).json({ ok: false, code: "card_type_not_found" });
    return;
  }

  // チャンク分割して書き込む（各バッチ最大500件）。
  let created = 0;
  try {
    for (let offset = 0; offset < count; offset += BATCH_LIMIT) {
      const chunk = Math.min(BATCH_LIMIT, count - offset);
      const batch = db.batch();
      for (let i = 0; i < chunk; i++) {
        const ref = giftCardsRef.doc();
        batch.set(ref, {
          token: generateCardToken(),
          cardTypeId,
          status: CARD_STATUS.UNUSED,
          memo: "",
          printed: false, // 未印刷。印刷用PDF出力（?markPrinted=1）で true になる。
          createdAt: FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
        });
      }
      await batch.commit();
      created += chunk;
    }
  } catch (err) {
    logger.error("adminGenerateGiftCards: batch write failed", {
      cardTypeId,
      requested: count,
      created,
      message: err instanceof Error ? err.message : "unknown",
    });
    // 途中まで作れているかもしれないので created を返す（べき等ではないが、二重生成より安全側）。
    res.status(500).json({ ok: false, code: "write_failed", created });
    return;
  }

  logger.info("adminGenerateGiftCards: created", { cardTypeId, created });
  res.status(200).json({ ok: true, created });
});

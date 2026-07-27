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
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { CARD_STATUS, QR_GENERATION, CARD_KIND, DEFAULT_CARD_KIND } from "../config/constants";
import { HTTP_OPTIONS } from "./options";
import { db, giftCardsRef, giftCardTypesRef } from "../lib/firestore";
import { GiftCardData } from "../models";
import { generateCardToken } from "../lib/token";
import { applyCors } from "./cors";
import { requireAuth } from "./guard";

// Firestore の一括書き込み（WriteBatch）は1回あたり最大500オペレーション。
// これを超える個数はチャンク分割して複数バッチで書く。
const BATCH_LIMIT = 500;

interface GenerateBody {
  cardTypeId?: unknown;
  count?: unknown;
  /** kind=coupon 生成時のみ: クーポン有効期限の絶対日付 "YYYY-MM-DD"（ロット単位・B案）。 */
  expiryDate?: unknown;
}

/**
 * "YYYY-MM-DD" を JST のその日の終わり(23:59:59)の Timestamp に変換する。
 * クーポンの有効期限は「その日いっぱい有効」にしたいので end-of-day を採用。
 * 妥当な日付でなければ null を返す（呼び出し側で 400 にする）。
 */
export function parseExpiryDateJst(raw: string): Timestamp | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // JST 23:59:59 = 同日 14:59:59 UTC（JST=UTC+9）。
  const ms = Date.UTC(y, mo - 1, d, 23, 59, 59, 999) - 9 * 60 * 60 * 1000;
  const check = new Date(ms + 9 * 60 * 60 * 1000);
  // 桁合わせ後に実在しない日付（例 2-30）を弾く。
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return Timestamp.fromMillis(ms);
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
  const expiryDateRaw = typeof body.expiryDate === "string" ? body.expiryDate.trim() : "";

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

  // 種別の kind を確定（未設定は catalog＝後方互換）。生成カードへデノーマライズする。
  const kind = typeSnap.data()?.kind ?? DEFAULT_CARD_KIND;

  // kind=coupon は有効期限（絶対日付）をロット単位で必須指定（B案）。catalog は従来通り expiryDate 不使用。
  let couponExpiryAt: Timestamp | null = null;
  if (kind === CARD_KIND.COUPON) {
    if (!expiryDateRaw) {
      res.status(400).json({ ok: false, code: "expiry_required", message: "expiryDate is required for coupon" });
      return;
    }
    couponExpiryAt = parseExpiryDateJst(expiryDateRaw);
    if (!couponExpiryAt) {
      res.status(400).json({ ok: false, code: "invalid_expiry", message: "expiryDate must be a valid YYYY-MM-DD" });
      return;
    }
    if (couponExpiryAt.toMillis() <= Date.now()) {
      res.status(400).json({ ok: false, code: "invalid_expiry", message: "expiryDate must be in the future" });
      return;
    }
  }

  // このリクエスト（一括生成）を1ロットとして識別する batchId。ロット絞り込み・突合に使う。
  const batchId = generateCardToken();
  const generatedAt = FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp;

  // チャンク分割して書き込む（各バッチ最大500件）。
  let created = 0;
  try {
    for (let offset = 0; offset < count; offset += BATCH_LIMIT) {
      const chunk = Math.min(BATCH_LIMIT, count - offset);
      const batch = db.batch();
      for (let i = 0; i < chunk; i++) {
        const ref = giftCardsRef.doc();
        // 共通フィールド（catalog/coupon 共通）。カタログ生成の書き込み内容は従来と同一＋kind のみ追加。
        const cardData: GiftCardData = {
          kind, // 種類をデノーマライズ（受け取り者フローの振り分け・一覧絞り込み用）。
          token: generateCardToken(),
          cardTypeId,
          status: CARD_STATUS.UNUSED,
          memo: "",
          printed: false, // 未印刷。印刷用PDF出力（?markPrinted=1）で true になる。
          createdAt: FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
          generatedAt, // ロット管理: 生成日時（バッチ内は同一）。
          batchId,     // ロット管理: 同一の一括生成をまとめる識別子。
        };
        // coupon 固有: クーポン有効期限（絶対日付・ロット単位。QRゲートと createCoupon.endedAt 兼用）。
        if (couponExpiryAt) cardData.couponExpiryAt = couponExpiryAt;
        batch.set(ref, cardData);
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

  logger.info("adminGenerateGiftCards: created", { cardTypeId, kind, created, batchId });
  res.status(200).json({ ok: true, created, batchId, kind });
});

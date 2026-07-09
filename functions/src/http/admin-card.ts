/*
 * 管理API: 受注内容の直接編集 / 使用済みカードのやり直し（未使用へ戻す）
 *
 * 直Firestoreではなく Functions 経由にする理由:
 *   - 受け取り者フォームと**同一のバリデーション**（カナ/メール/配達日範囲/時間帯）をサーバ側で適用する
 *     （order-fields.ts を共有）。
 *   - トランザクションで状態遷移を原子的に扱い、既存の二重確定防止と衝突しないようにする。
 *   - 「やり直し」で戻す直前の入力を履歴（previousSubmissions）にサーバ側で確実に記録する。
 *
 * 認証: Firebase Auth IDトークン（requireAuth）。ログイン済み＝管理者。
 * NE投入済みカードへの警告は UI 側で表示（neStatus はカード詳細に含まれる）。ここでは操作をブロックしない。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { CARD_STATUS } from "../config/constants";
import { HTTP_OPTIONS } from "./options";
import { db, giftCardsRef, selectableProductsRef } from "../lib/firestore";
import { PreviousSubmission } from "../models";
import { applyCors } from "./cors";
import { requireAuth } from "./guard";
import {
  OrderError, validateAddress, validateEmail, validateDeliveryDate, validateDeliveryTime,
} from "./order-fields";

/**
 * POST /api/adminUpdateGiftCard
 *   body: { cardId, selectedProductId, shippingAddress:{...}, email, deliveryDate?, deliveryTime? }
 *   使用済みカードの受注内容（配送先・カナ・メール・選択商品・配達希望）を管理者が直接上書きする。
 *   選択商品は同じ種別に属すること（種別をまたがない）。neStatus・usedAt は変更しない
 *   （NE側は自動更新されないため。UI で警告する）。
 *   res(200): { ok:true } / 400 invalid_* / 404 not_found / 409 not_used
 */
export const adminUpdateGiftCard = onRequest(HTTP_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
  const selectedProductId = typeof body.selectedProductId === "string" ? body.selectedProductId.trim() : "";
  if (!cardId || !selectedProductId) { res.status(400).json({ ok: false, code: "invalid_argument" }); return; }

  let shippingAddress; let recipientEmail; let deliveryDate; let deliveryTime;
  try {
    shippingAddress = validateAddress(body.shippingAddress);
    recipientEmail = validateEmail(body.email);
    deliveryDate = validateDeliveryDate(body.deliveryDate);
    deliveryTime = validateDeliveryTime(body.deliveryTime);
  } catch (e) {
    if (e instanceof OrderError) { res.status(e.httpStatus).json({ ok: false, code: e.code }); return; }
    throw e;
  }

  try {
    await db.runTransaction(async (tx) => {
      const ref = giftCardsRef.doc(cardId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new OrderError(404, "not_found");
      const card = snap.data()!;
      // 編集対象は使用済み（受注内容がある）カードのみ。
      if (card.status !== CARD_STATUS.USED) throw new OrderError(409, "not_used");
      // 選択商品は実在し、同じ種別に属すること（種別をまたがない）。
      const prodDoc = await tx.get(selectableProductsRef.doc(selectedProductId));
      if (!prodDoc.exists) throw new OrderError(400, "invalid_product");
      if (prodDoc.data()!.cardTypeId !== card.cardTypeId) throw new OrderError(400, "invalid_product");

      // 任意項目（配達希望）は空なら削除。neStatus・usedAt は据え置き（NEは手動修正）。
      const update: Record<string, unknown> = {
        selectedProductId,
        shippingAddress,
        recipientEmail,
        deliveryDate: deliveryDate ? deliveryDate : FieldValue.delete(),
        deliveryTime: deliveryTime ? deliveryTime : FieldValue.delete(),
        lastEditedAt: FieldValue.serverTimestamp(),
        lastEditedBy: admin.email ?? "",
      };
      tx.update(ref, update);
    });
  } catch (err) {
    if (err instanceof OrderError) { res.status(err.httpStatus).json({ ok: false, code: err.code }); return; }
    logger.error("adminUpdateGiftCard failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
    return;
  }
  logger.info("adminUpdateGiftCard", { cardId, by: admin.email ?? "" });
  res.status(200).json({ ok: true });
});

/**
 * POST /api/adminResetGiftCard
 *   body: { cardId }
 *   使用済みカードを未使用へ戻し、受け取り者が同じURLから再入力できる状態にする。
 *   戻す直前の入力は previousSubmissions に履歴として push（消さずに残す）。トークンは不変。
 *   res(200): { ok:true, historyCount } / 404 not_found / 409 not_used
 */
export const adminResetGiftCard = onRequest(HTTP_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
  if (!cardId) { res.status(400).json({ ok: false, code: "invalid_argument" }); return; }

  let historyCount = 0;
  try {
    await db.runTransaction(async (tx) => {
      const ref = giftCardsRef.doc(cardId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new OrderError(404, "not_found");
      const card = snap.data()!;
      if (card.status !== CARD_STATUS.USED) throw new OrderError(409, "not_used");

      // 戻す直前の内容を履歴に積む（配列内に serverTimestamp は置けないため resetAt は now）。
      const snapshot: PreviousSubmission = {
        selectedProductId: card.selectedProductId,
        shippingAddress: card.shippingAddress,
        recipientEmail: card.recipientEmail,
        deliveryDate: card.deliveryDate,
        deliveryTime: card.deliveryTime,
        usedAt: card.usedAt,
        neStatus: card.neStatus,
        resetAt: Timestamp.now(),
        resetBy: admin.email ?? "",
      };
      const history = Array.isArray(card.previousSubmissions)
        ? [...card.previousSubmissions, snapshot]
        : [snapshot];
      historyCount = history.length;

      // カード本体は未使用へ。受注内容・確定情報・NE状態はクリア（再入力・再確定できる状態に）。
      tx.update(ref, {
        status: CARD_STATUS.UNUSED,
        previousSubmissions: history,
        selectedProductId: FieldValue.delete(),
        shippingAddress: FieldValue.delete(),
        recipientEmail: FieldValue.delete(),
        deliveryDate: FieldValue.delete(),
        deliveryTime: FieldValue.delete(),
        usedAt: FieldValue.delete(),
        neStatus: FieldValue.delete(),
        neSubmittedAt: FieldValue.delete(),
        neLastError: FieldValue.delete(),
        neAttempts: FieldValue.delete(),
      });
    });
  } catch (err) {
    if (err instanceof OrderError) { res.status(err.httpStatus).json({ ok: false, code: err.code }); return; }
    logger.error("adminResetGiftCard failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
    return;
  }
  logger.info("adminResetGiftCard", { cardId, historyCount, by: admin.email ?? "" });
  res.status(200).json({ ok: true, historyCount });
});

/**
 * POST /api/adminSetCardExpiry
 *   body: { cardId, expiryDaysOverride }
 *     expiryDaysOverride: 正の整数 = 個別上書き（種別デフォルトより優先） / 空・null・0以下 = 上書き解除。
 *   個別カードの有効期限日数を上書きする。**期限切れカードの延長（救済）**にも使う（status 不問）。
 *   期限は generatedAt を起点に算出されるため、延ばした日数で再び期限内になれば受け取り者が再び使える。
 *   res(200): { ok:true } / 400 invalid_argument / 404 not_found
 */
export const adminSetCardExpiry = onRequest(HTTP_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
  if (!cardId) { res.status(400).json({ ok: false, code: "invalid_argument" }); return; }

  // 上書き値の解釈: 正の整数のみ設定、空/null/0以下は「上書き解除」。
  const raw = body.expiryDaysOverride;
  const n = typeof raw === "number" ? raw
    : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
  const setVal: number | null = Number.isInteger(n) && n > 0 ? n : null;

  try {
    const ref = giftCardsRef.doc(cardId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ ok: false, code: "not_found" }); return; }
    await ref.update({ expiryDaysOverride: setVal === null ? FieldValue.delete() : setVal });
  } catch (err) {
    logger.error("adminSetCardExpiry failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
    return;
  }
  logger.info("adminSetCardExpiry", { cardId, expiryDaysOverride: setVal, by: admin.email ?? "" });
  res.status(200).json({ ok: true, expiryDaysOverride: setVal });
});

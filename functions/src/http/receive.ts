/**
 * 受け取り者API（design.md 4.2 / 第9章 手順5）
 *
 * 受け取り者フローは **全面 Cloud Functions 経由**。トークン照合・確定・使用済み化をサーバ側で行い、
 * クライアントからの Firestore 直アクセスは禁止のまま（firestore.rules は受け取り者向けの口を開けない）。
 * トークンが唯一の外部アクセス制御（design.md 第8章）。
 *
 * エンドポイント:
 *   - GET  /api/receiveGetCard?token=...   … トークンでカードを引き、状態＋商品ラインナップを返す。
 *   - POST /api/receiveConfirm             … 商品選択＋住所を受け、トランザクションで確定・使用済み化。
 *
 * NE投入は第6ステップ本体で実装。第5では確定時に neStatus:"pending"（未投入）を記録するのみ（スタブ）。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { REGION, CARD_STATUS, NE_STATUS } from "../config/constants";
import { db, giftCardsRef, giftCardTypesRef, selectableProductsRef } from "../lib/firestore";
import { ShippingAddress } from "../models";
import { applyCors } from "./cors";

// ざっくりした業務エラー（HTTPステータスへマップする）。
class ReceiveError extends Error {
  constructor(public httpStatus: number, public code: string) {
    super(code);
  }
}

// クエリ or ボディからトークンを取り出す。
function tokenOf(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

// 配送先住所の検証。必須文字列が揃っているかを確認し、正規化して返す。
function validateAddress(raw: unknown): ShippingAddress {
  const a = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const addr: ShippingAddress = {
    name: str(a.name),
    postalCode: str(a.postalCode),
    prefecture: str(a.prefecture),
    address: str(a.address),
    building: str(a.building) || undefined,
    phone: str(a.phone),
  };
  // building 以外は必須。
  if (!addr.name || !addr.postalCode || !addr.prefecture || !addr.address || !addr.phone) {
    throw new ReceiveError(400, "invalid_address");
  }
  return addr;
}

/**
 * GET /api/receiveGetCard?token=...
 *   res(200): { ok:true, status:"unused", cardType:{id,name,price}, products:[{id,name,description,imageUrl}] }
 *       あるいは { ok:true, status:"used" }（使用済み＝二重利用防止表示用。商品情報は返さない）
 *   res(404): { ok:false, code:"not_found" }（無効トークン）
 */
export const receiveGetCard = onRequest({ region: REGION }, async (req, res) => {
  applyCors(req.headers, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const token = tokenOf(req.query.token);
  if (!token) { res.status(400).json({ ok: false, code: "invalid_argument" }); return; }

  try {
    const cardSnap = await giftCardsRef.where("token", "==", token).limit(1).get();
    if (cardSnap.empty) { res.status(404).json({ ok: false, code: "not_found" }); return; }
    const card = cardSnap.docs[0].data();

    // 使用済みなら商品情報は返さず状態のみ（二重利用防止表示）。
    if (card.status === CARD_STATUS.USED) {
      res.status(200).json({ ok: true, status: CARD_STATUS.USED });
      return;
    }

    // 種別＋その種別に紐づく有効な商品ラインナップを返す。
    const [typeSnap, prodSnap] = await Promise.all([
      giftCardTypesRef.doc(card.cardTypeId).get(),
      selectableProductsRef.where("cardTypeId", "==", card.cardTypeId).where("active", "==", true).get(),
    ]);
    const type = typeSnap.data();
    const products = prodSnap.docs.map((d) => {
      const p = d.data();
      return { id: d.id, name: p.name, description: p.description, imageUrl: p.imageUrl };
    });

    res.status(200).json({
      ok: true,
      status: CARD_STATUS.UNUSED,
      cardType: type ? { id: typeSnap.id, name: type.name, price: type.price } : null,
      products,
    });
  } catch (err) {
    logger.error("receiveGetCard failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

/**
 * POST /api/receiveConfirm
 *   body: { token, selectedProductId, shippingAddress:{name,postalCode,prefecture,address,building?,phone} }
 *   res(200): { ok:true }
 *   res(400): invalid_argument / invalid_address / invalid_product
 *   res(404): not_found（無効トークン）
 *   res(409): already_used（同時確定・再確定＝二重利用防止）
 *
 * 二重確定防止: トランザクション内で「status が unused であること」を検証してから used に更新する。
 */
export const receiveConfirm = onRequest({ region: REGION }, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = tokenOf(body.token);
  const selectedProductId = typeof body.selectedProductId === "string" ? body.selectedProductId.trim() : "";
  if (!token || !selectedProductId) { res.status(400).json({ ok: false, code: "invalid_argument" }); return; }

  let shippingAddress: ShippingAddress;
  try {
    shippingAddress = validateAddress(body.shippingAddress);
  } catch (e) {
    if (e instanceof ReceiveError) { res.status(e.httpStatus).json({ ok: false, code: e.code }); return; }
    throw e;
  }

  try {
    await db.runTransaction(async (tx) => {
      // --- 読み取りはすべて書き込みより前に行う（Firestoreトランザクション制約）---
      const cardSnap = await tx.get(giftCardsRef.where("token", "==", token).limit(1));
      if (cardSnap.empty) throw new ReceiveError(404, "not_found");
      const cardDoc = cardSnap.docs[0];
      const card = cardDoc.data();

      // 二重確定防止の要: この瞬間に unused であることを検証する。
      if (card.status !== CARD_STATUS.UNUSED) throw new ReceiveError(409, "already_used");

      // 選択商品の妥当性: 実在し、同じ種別に属し、有効であること（1カード1商品 / design.md 3.3）。
      const prodDoc = await tx.get(selectableProductsRef.doc(selectedProductId));
      if (!prodDoc.exists) throw new ReceiveError(400, "invalid_product");
      const prod = prodDoc.data()!;
      if (prod.cardTypeId !== card.cardTypeId || prod.active === false) {
        throw new ReceiveError(400, "invalid_product");
      }

      // --- 書き込み: 使用済み化＋確定内容の記録。NE投入は第6でのため neStatus は pending（未投入）---
      tx.update(cardDoc.ref, {
        status: CARD_STATUS.USED,
        selectedProductId,
        shippingAddress,
        usedAt: FieldValue.serverTimestamp(),
        neStatus: NE_STATUS.PENDING,
      });
    });
  } catch (err) {
    if (err instanceof ReceiveError) {
      // 業務エラーは想定内。409/404/400 をそのまま返す（ログは軽く）。
      if (err.httpStatus >= 500) logger.error("receiveConfirm error", { code: err.code });
      res.status(err.httpStatus).json({ ok: false, code: err.code });
      return;
    }
    logger.error("receiveConfirm failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
    return;
  }

  res.status(200).json({ ok: true });
});

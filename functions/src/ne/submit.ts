/**
 * NE 自動投入のオーケストレーション（claim → submit → 状態更新）
 *
 * 非同期・裏方の投入（design.md 第6章 / 本ステップ方針）:
 *   - 確定は neStatus:pending で必ず成功させ（受け取り者体験を巻き添えにしない）、
 *     投入はここで別途行う。Firestoreトリガー（確定の瞬間）と手動リトライの双方から呼ぶ。
 *   - **claim**: トランザクションで pending → submitting に原子的に遷移させ、二重投入を防ぐ。
 *   - 成功: submitting → submitted（+ neSubmittedAt）。
 *   - 失敗: submitting → pending（+ neLastError / neAttempts++）。**pending に戻す＝リトライ可能**。
 *     status は used のまま変えないため、確定トリガーの再発火ループは起きない。
 */

import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { CARD_STATUS, NE_STATUS } from "../config/constants";
import { neConfig } from "../config/env";
import { db, giftCardsRef, selectableProductsRef } from "../lib/firestore";
import { neApiCall, NeCallDeps } from "./client";
import { buildOrderParams } from "./order";

export type SubmitResult = "submitted" | "skipped" | "failed";

/**
 * 1枚のカードを NE へ投入しようと試みる。
 *   - skipped: 対象外（used でない / pending でない / 既に処理済み等）。
 *   - submitted: 投入成功（neStatus=submitted）。
 *   - failed: 投入失敗（neStatus は pending に戻し、リトライ可能）。
 */
export async function trySubmitCard(cardId: string, deps: NeCallDeps = {}): Promise<SubmitResult> {
  const cardRef = giftCardsRef.doc(cardId);

  // --- claim: pending → submitting を原子的に確保（他ワーカー/再実行との競合を防ぐ）---
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    if (!snap.exists) return null;
    const card = snap.data()!;
    if (card.status !== CARD_STATUS.USED) return null;
    if (card.neStatus !== NE_STATUS.PENDING) return null; // 既に submitting/submitted/csv 等
    tx.update(cardRef, { neStatus: NE_STATUS.SUBMITTING });
    return card;
  });
  if (!claimed) return "skipped";

  try {
    if (!claimed.selectedProductId) throw new Error("selectedProductId missing");
    const prodSnap = await selectableProductsRef.doc(claimed.selectedProductId).get();
    const prod = prodSnap.data();
    if (!prod) throw new Error("selected product not found");
    if (!claimed.shippingAddress) throw new Error("shippingAddress missing");

    const params = buildOrderParams({
      token: claimed.token,
      neProductCode: prod.neProductCode,
      quantity: 1, // 1カード=1商品（design.md 3.3）
      address: claimed.shippingAddress,
    });

    await neApiCall(neConfig().orderEndpoint, params, deps);

    await cardRef.update({
      neStatus: NE_STATUS.SUBMITTED,
      neSubmittedAt: FieldValue.serverTimestamp(),
      neLastError: FieldValue.delete(),
    });
    return "submitted";
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    logger.error("trySubmitCard failed", { cardId, message });
    // pending に戻す（リトライ可能に）。status は used のまま＝確定トリガーは再発火しない。
    await cardRef.update({
      neStatus: NE_STATUS.PENDING,
      neLastError: message,
      neAttempts: FieldValue.increment(1),
    });
    return "failed";
  }
}

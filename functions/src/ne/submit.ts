/**
 * NE 自動投入のオーケストレーション（2段階：アップロード受付 → キュー確認）
 *
 * 受注伝票アップロードAPIは**非同期キュー方式**なので、投入は2段階になる（design.md 第6章 / 実接続方針）:
 *   [1] trySubmitCard: 確定済みカードの CSV を作ってアップロードAPIへ送信し、que_id を受け取って **queued** にする。
 *       - claim: トランザクションで pending → submitting に原子的に遷移（二重投入防止）。
 *       - 送信成功: submitting → queued（+ neQueId / neQueuedAt）。※まだ submitted にしない（取り込み未確定）。
 *       - 送信失敗: submitting → pending（+ neLastError / neAttempts++）＝リトライ可能。
 *   [2] advanceQueuedCard: queued のカードの que_id をキュー検索して取り込み結果を確定する。
 *       - 成功(==2): queued → submitted（+ neSubmittedAt）。
 *       - 失敗(==-1): queued → pending（+ neLastError=que_message / neAttempts++）＝リトライ可能。
 *       - 処理中/待ち/未検出: queued のまま（次回再確認）。
 *
 * いずれも status は used のまま変えないため、確定トリガーの再発火ループは起きない。
 */

import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { CARD_STATUS, NE_STATUS } from "../config/constants";
import { db, giftCardsRef, selectableProductsRef } from "../lib/firestore";
import { NeCallDeps } from "./client";
import { giftCardToNeCsvRow } from "./rows";
import { uploadNeCsvRows } from "./upload";
import { checkQueStatus } from "./que";

export type SubmitResult = "queued" | "failed" | "skipped";
export type AdvanceResult = "submitted" | "failed" | "waiting" | "skipped";

/**
 * [1] 1枚のカードを NE 受注伝票アップロードAPIへ投入する（受付まで）。
 *   - skipped: 対象外（used でない / pending でない / 既に処理済み等）。
 *   - queued: アップロード受付成功（neStatus=queued・que_id 保持）。取り込み成否は advanceQueuedCard で確定。
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
    if (card.neStatus !== NE_STATUS.PENDING) return null; // 既に submitting/queued/submitted/csv 等
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

    // 実証済みの41列CSV（1行）を作ってアップロード。管理画面CSV出力と同一のマッピング（ne/rows.ts）。
    const row = giftCardToNeCsvRow(claimed, { name: prod.name, neProductCode: prod.neProductCode });
    const { queId } = await uploadNeCsvRows([row], deps);

    await cardRef.update({
      neStatus: NE_STATUS.QUEUED,
      neQueId: queId,
      neQueuedAt: FieldValue.serverTimestamp(),
      neLastError: FieldValue.delete(),
    });
    logger.info("trySubmitCard queued", { cardId, queId });
    return "queued";
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

/**
 * [2] queued のカードの取り込み結果を確認して確定させる。
 *   - skipped: 対象外（queued でない / que_id なし）。
 *   - submitted: 取り込み成功（que_status_id==2）。
 *   - failed: 取り込み失敗（que_status_id==-1）→ pending に戻す（リトライ可能）。
 *   - waiting: まだ処理中/処理待ち/未検出 → queued のまま（次回再確認）。
 */
export async function advanceQueuedCard(cardId: string, deps: NeCallDeps = {}): Promise<AdvanceResult> {
  const cardRef = giftCardsRef.doc(cardId);
  const snap = await cardRef.get();
  if (!snap.exists) return "skipped";
  const card = snap.data()!;
  if (card.neStatus !== NE_STATUS.QUEUED || !card.neQueId) return "skipped";

  let result;
  try {
    result = await checkQueStatus(String(card.neQueId), deps);
  } catch (err) {
    // 検索自体の失敗は queued を維持（取り込みの成否は不明のまま。次回再確認）。
    logger.error("advanceQueuedCard: que search failed", {
      cardId, message: err instanceof Error ? err.message : "unknown",
    });
    return "waiting";
  }

  if (result.status === "success") {
    await cardRef.update({
      neStatus: NE_STATUS.SUBMITTED,
      neSubmittedAt: FieldValue.serverTimestamp(),
      neLastError: FieldValue.delete(),
    });
    logger.info("advanceQueuedCard submitted", { cardId, queId: card.neQueId });
    return "submitted";
  }
  if (result.status === "failed") {
    await cardRef.update({
      neStatus: NE_STATUS.PENDING,
      neLastError: `que failed: ${result.message}`.slice(0, 500),
      neAttempts: FieldValue.increment(1),
    });
    logger.warn("advanceQueuedCard failed → pending", { cardId, queId: card.neQueId, message: result.message });
    return "failed";
  }
  // processing / waiting / unknown（未検出含む）: queued のまま。
  logger.info("advanceQueuedCard still waiting", { cardId, queId: card.neQueId, status: result.status });
  return "waiting";
}

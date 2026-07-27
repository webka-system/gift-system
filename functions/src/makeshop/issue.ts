/**
 * クーポン発行のオーケストレーション（claim → MakeShop createCoupon → 保存）
 *
 * 二重発行防止は既存カタログ（ne/submit.ts の trySubmitCard）と同じ claim パターン:
 *   1) トランザクションで「status==unused かつ couponStatus∉{issuing,issued}」を検証し、
 *      couponStatus="issuing" を原子的に確保（＝発行枠のロック）。status は unused のまま。
 *   2) （トランザクション外で）MakeShop createCoupon を呼ぶ（コード重複はコード再生成でリトライ）。
 *   3) 成功: status="used" ＋ couponStatus="issued" ＋ couponCode を保存（以後は保存済みコードを表示）。
 *   4) 失敗: couponStatus を消して未使用へ戻す（＝カードは未使用のまま・リトライ可）。couponLastError を記録。
 *
 * この関数は「1カードのクーポンを発行して確定する」単位で、管理テスト発行と受け取り者フローの両方から使う。
 */

import { logger } from "firebase-functions/v2";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { CARD_STATUS, CARD_KIND, COUPON_STATUS, DEFAULT_CARD_KIND } from "../config/constants";
import { db, giftCardsRef, giftCardTypesRef } from "../lib/firestore";
import { MakeshopCallDeps } from "./client";
import { createCouponWithRetry } from "./coupon";

export type IssueResult = "issued" | "failed" | "skipped";

export interface IssueOutcome {
  result: IssueResult;
  /** 発行済み（または既発行）のクーポンコード。 */
  couponCode?: string;
  /** 失敗理由（couponLastError と同じ）。 */
  error?: string;
  /** skipped の理由（already_issued / not_coupon / already_used / not_found / issuing など）。 */
  reason?: string;
  /** MakeShop の生レスポンス（デバッグ用。失敗時にそのまま見せる）。 */
  raw?: unknown;
}

/** ミリ秒 → JST の "YYYY-MM-DD HH:mm:ss"（MakeShop startedAt/endedAt の書式。Go 参照時刻 2006-01-02 15:04:05）。 */
function toJstDateTimeStr(ms: number): string {
  const j = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())} ` +
    `${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`;
}

/**
 * 1カードのクーポンを発行して確定する。
 *   - skipped: 対象外（存在しない / coupon でない / 既に used / 既に issued / issuing 中）。
 *   - issued : 発行成功（status=used・couponStatus=issued・couponCode 保存）。既に issued のカードもコードを返す。
 *   - failed : 発行失敗（未使用のまま。couponLastError 記録・リトライ可）。errorMessage は error/raw で確認可。
 */
export async function issueCouponForCard(cardId: string, deps: MakeshopCallDeps = {}): Promise<IssueOutcome> {
  const cardRef = giftCardsRef.doc(cardId);

  // --- claim: unused かつ未発行のときだけ couponStatus=issuing を確保（競合・連打で二重発行しない）---
  const claim = await db.runTransaction(async (tx): Promise<
    { ok: true; card: FirebaseFirestore.DocumentData } | { ok: false; reason: string; couponCode?: string }
  > => {
    const snap = await tx.get(cardRef);
    if (!snap.exists) return { ok: false, reason: "not_found" };
    const card = snap.data()!;
    const kind = card.kind ?? DEFAULT_CARD_KIND;
    if (kind !== CARD_KIND.COUPON) return { ok: false, reason: "not_coupon" };
    // 既に発行済みなら保存済みコードを返す（都度発行の2回目以降＝APIを叩かない）。
    if (card.couponStatus === COUPON_STATUS.ISSUED) {
      return { ok: false, reason: "already_issued", couponCode: card.couponCode };
    }
    // 発行処理中（別リクエストが claim 済み）。二重発行を避けて待たせる。
    if (card.couponStatus === COUPON_STATUS.ISSUING) return { ok: false, reason: "issuing" };
    // 有効期限切れは新規発行しない（QR/クーポンの有効期限ゲート）。既発行なら上で code を返している。
    const exp = card.couponExpiryAt as Timestamp | undefined;
    if (exp && typeof exp.toMillis === "function" && Date.now() > exp.toMillis()) {
      return { ok: false, reason: "expired" };
    }
    // 使用済み（コード未保持でusedは通常無いが安全側）。
    if (card.status !== CARD_STATUS.UNUSED) return { ok: false, reason: "already_used" };
    tx.update(cardRef, { couponStatus: COUPON_STATUS.ISSUING });
    return { ok: true, card };
  });

  if (!claim.ok) {
    // already_issued は「発行済みコードを返す」ので issued 扱い（受け取り者の再アクセスと同じ挙動）。
    if (claim.reason === "already_issued") {
      return { result: "issued", couponCode: claim.couponCode, reason: "already_issued" };
    }
    return { result: "skipped", reason: claim.reason };
  }

  const card = claim.card;
  try {
    // 種別のクーポン設定（割引方式・額）を読む。
    const typeSnap = await giftCardTypesRef.doc(String(card.cardTypeId)).get();
    const cfg = typeSnap.data()?.couponConfig;
    if (!cfg) throw new Error("couponConfig not found on card type");
    const expiry = card.couponExpiryAt as Timestamp | undefined;
    if (!expiry || typeof expiry.toMillis !== "function") throw new Error("couponExpiryAt missing on card");

    const typeName = String(typeSnap.data()?.name ?? "クーポン");
    // 利用期間: 開始=発行時刻（今）、終了=クーポン有効期限（couponExpiryAt=その日の23:59:59 JST）。
    const result = await createCouponWithRetry(
      {
        name: typeName,
        discount: { discountType: cfg.discountType, discountValue: cfg.discountValue },
        minimumPrice: cfg.minimumPrice,
        startedAt: toJstDateTimeStr(Date.now()),
        endedAt: toJstDateTimeStr(expiry.toMillis()),
      },
      deps,
    );

    if (!result.ok || !result.code) {
      throw new MakeshopIssueError(result.errorMessage || "createCoupon failed", result.raw);
    }

    // 成功: 使用済み化＋コード保存。以後の再アクセスは保存済みコードを表示するだけ。
    await cardRef.update({
      status: CARD_STATUS.USED,
      couponStatus: COUPON_STATUS.ISSUED,
      couponCode: result.code,
      couponIssuedAt: FieldValue.serverTimestamp(),
      couponLastError: FieldValue.delete(),
    });
    logger.info("issueCouponForCard issued", { cardId });
    return { result: "issued", couponCode: result.code, raw: result.raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    const raw = err instanceof MakeshopIssueError ? err.raw : undefined;
    logger.error("issueCouponForCard failed", { cardId, message });
    // couponStatus を消して未使用へ戻す（リトライ可能に）。status は unused のまま。
    await cardRef.update({
      couponStatus: FieldValue.delete(),
      couponLastError: message.slice(0, 500),
      couponAttempts: FieldValue.increment(1),
    });
    return { result: "failed", error: message, raw };
  }
}

/** createCoupon 失敗を生レスポンス付きで運ぶ内部エラー。 */
class MakeshopIssueError extends Error {
  constructor(message: string, public raw?: unknown) {
    super(message);
    this.name = "MakeshopIssueError";
  }
}

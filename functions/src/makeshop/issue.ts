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
import { createCouponWithRetry, reissueName } from "./coupon";

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

/** issueCouponForCard のオプション（MakeShop呼び出しの注入＋再発行フラグ）。 */
export interface IssueOptions extends MakeshopCallDeps {
  /** true: 管理画面からの手動（再）発行。名前に【再発行 M/D】を付け、既発行カードも再発行できる。 */
  reissue?: boolean;
}

/**
 * 1カードのクーポンを発行して確定する。
 *   - skipped: 対象外（存在しない / coupon でない / issuing 中 / 期限切れ / 通常発行で既に used）。
 *   - issued : 発行成功（status=used・couponStatus=issued・couponCode 保存）。通常発行で既発行ならコードを返す。
 *   - failed : 発行失敗（couponLastError 記録・リトライ可）。errorMessage は error/raw で確認可。
 *
 * reissue=true（管理画面の手動再発行）:
 *   - 既に issued/used のカードでも再発行する（MakeShop に別のクーポンが作られる）。couponCode は新コードで上書き。
 *   - 名前に【再発行 M/D】を付ける（初回発行と区別・トラブル追跡用）。
 *   - 失敗時は「元が発行済みなら発行済み(旧コード保持)に戻す／元が未発行なら未発行に戻す」。
 */
export async function issueCouponForCard(cardId: string, opts: IssueOptions = {}): Promise<IssueOutcome> {
  const { reissue = false, ...deps } = opts;
  const cardRef = giftCardsRef.doc(cardId);

  // --- claim: couponStatus=issuing を原子的に確保（競合・連打で二重発行しない）---
  const claim = await db.runTransaction(async (tx): Promise<
    { ok: true; card: FirebaseFirestore.DocumentData; wasIssued: boolean } | { ok: false; reason: string; couponCode?: string }
  > => {
    const snap = await tx.get(cardRef);
    if (!snap.exists) return { ok: false, reason: "not_found" };
    const card = snap.data()!;
    const kind = card.kind ?? DEFAULT_CARD_KIND;
    if (kind !== CARD_KIND.COUPON) return { ok: false, reason: "not_coupon" };
    // 発行処理中（別リクエストが claim 済み）。二重発行を避けて待たせる（通常・再発行とも）。
    if (card.couponStatus === COUPON_STATUS.ISSUING) return { ok: false, reason: "issuing" };
    // 有効期限切れは（再）発行しない（QR/クーポンの有効期限ゲート）。
    const exp = card.couponExpiryAt as Timestamp | undefined;
    const expired = exp && typeof exp.toMillis === "function" && Date.now() > exp.toMillis();

    const wasIssued = card.couponStatus === COUPON_STATUS.ISSUED;
    if (reissue) {
      if (expired) return { ok: false, reason: "expired" };
      // 既発行/使用済みでも再発行を許可（新しいクーポンを作る）。couponStatus=issuing を確保。
      tx.update(cardRef, { couponStatus: COUPON_STATUS.ISSUING });
      return { ok: true, card, wasIssued };
    }
    // ── 通常発行（受け取り者の自動発行）──
    // 既に発行済みなら保存済みコードを返す（都度発行の2回目以降＝APIを叩かない）。
    if (wasIssued) return { ok: false, reason: "already_issued", couponCode: card.couponCode };
    if (expired) return { ok: false, reason: "expired" };
    // 使用済み（コード未保持でusedは通常無いが安全側）。
    if (card.status !== CARD_STATUS.UNUSED) return { ok: false, reason: "already_used" };
    tx.update(cardRef, { couponStatus: COUPON_STATUS.ISSUING });
    return { ok: true, card, wasIssued: false };
  });

  if (!claim.ok) {
    // already_issued は「発行済みコードを返す」ので issued 扱い（受け取り者の再アクセスと同じ挙動）。
    if (claim.reason === "already_issued") {
      return { result: "issued", couponCode: claim.couponCode, reason: "already_issued" };
    }
    return { result: "skipped", reason: claim.reason };
  }

  const card = claim.card;
  const wasIssued = claim.wasIssued;
  try {
    // 種別のクーポン設定（割引方式・額）を読む。
    const typeSnap = await giftCardTypesRef.doc(String(card.cardTypeId)).get();
    const cfg = typeSnap.data()?.couponConfig;
    if (!cfg) throw new Error("couponConfig not found on card type");
    const expiry = card.couponExpiryAt as Timestamp | undefined;
    if (!expiry || typeof expiry.toMillis !== "function") throw new Error("couponExpiryAt missing on card");

    const baseName = String(typeSnap.data()?.name ?? "クーポン");
    // 管理画面からの手動（再）発行は名前に【再発行 M/D】を付ける。受け取り者の自動発行は元の名前のまま。
    const name = reissue ? reissueName(baseName, Date.now()) : baseName;
    // 利用期間: 開始=発行時刻（今）、終了=クーポン有効期限（couponExpiryAt=その日の23:59:59 JST）。
    const result = await createCouponWithRetry(
      {
        name,
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

    // 成功: 使用済み化＋コード保存。以後の再アクセスは保存済みコードを表示するだけ（再発行は新コードで上書き）。
    await cardRef.update({
      status: CARD_STATUS.USED,
      couponStatus: COUPON_STATUS.ISSUED,
      couponCode: result.code,
      couponIssuedAt: FieldValue.serverTimestamp(),
      couponLastError: FieldValue.delete(),
    });
    logger.info("issueCouponForCard issued", { cardId, reissue });
    return { result: "issued", couponCode: result.code, raw: result.raw };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    const raw = err instanceof MakeshopIssueError ? err.raw : undefined;
    logger.error("issueCouponForCard failed", { cardId, message, reissue });
    // 失敗時の復元: 元が発行済みなら「発行済み(旧コード保持)」に戻す（再発行失敗で旧コードを失わない）。
    //             元が未発行なら「未発行」に戻す（＝couponStatus 削除でリトライ可能）。status は据え置き。
    await cardRef.update({
      couponStatus: wasIssued ? COUPON_STATUS.ISSUED : FieldValue.delete(),
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

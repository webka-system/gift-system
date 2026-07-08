/**
 * NE 自動投入トリガー（design.md 第6章 / 本ステップ方針①）
 *
 * 受け取り者の確定（status: unused → used）の**瞬間だけ**反応し、NE への自動投入を試みる。
 * 以後の neStatus 書き換え（submitting/submitted/pending）では status が used のまま＝遷移しないため
 * 再発火しない（無限ループ防止）。実際の投入・状態更新は trySubmitCard（claim込み）に委譲する。
 *
 * 未設定/CSV運用時（isNeAutoConfigured=false）は何もしない → neStatus:pending のまま CSV 側が拾う。
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { REGION, CARD_STATUS, COLLECTIONS } from "../config/constants";
import { isNeAutoConfigured } from "../config/env";
import { trySubmitCard } from "../ne/submit";

export const onGiftCardConfirmed = onDocumentWritten(
  { document: `${COLLECTIONS.GIFT_CARDS}/{cardId}`, region: REGION },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const before = event.data?.before;
    const beforeStatus = before?.exists ? before.data()?.status : undefined;
    const afterStatus = after.data()?.status;

    // 確定の瞬間（used への遷移）だけを対象にする。
    if (beforeStatus === CARD_STATUS.USED || afterStatus !== CARD_STATUS.USED) return;

    // 自動投入が未設定/CSV運用なら何もしない（pending のまま CSV が拾う）。
    if (!isNeAutoConfigured()) {
      logger.debug("onGiftCardConfirmed: NE auto not configured; leaving pending", { cardId: event.params.cardId });
      return;
    }

    const result = await trySubmitCard(event.params.cardId);
    logger.info("onGiftCardConfirmed: NE submit attempted", { cardId: event.params.cardId, result });
  },
);

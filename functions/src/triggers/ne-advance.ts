/**
 * NE キュー自動確定（Cloud Scheduler / queued → submitted|pending）
 *
 * 受注伝票アップロードは非同期キューなので、トリガー(onGiftCardConfirmed)は queued 化までしか自動化できない。
 * その後の「que_id をキュー検索して取り込み結果を確定する」を、この定期実行で自動化する
 * （手動ボタン「取り込み結果を確認」を管理者が押して回らなくてよくする）。
 *
 * ★API呼び出し回数の節約（重要）:
 *   まず Firestore を見て **queued のカードが1件も無ければ NE API を一切叩かず即終了**する。
 *   これにより NE API 呼び出しは「受注数（queued の発生数）」に比例したままになり、定期実行の間隔を短くしても
 *   無駄打ちが増えない（queued 0件のtickは Firestore 読み取り1回だけ）。
 *
 * ★実行モード:
 *   **auto のときだけ**動く（isNeAutoConfigured）。manual/csv では動かさない
 *   （manual は「自動化せず管理者が手動ボタンで確認する」モードのため、勝手に確定させない）。
 *
 * ★API回数の内訳（que_id ごとに1回の que_id-eq 照会）:
 *   queued 1件につき system_que/search を1回。低ボリューム前提では各tickの queued は通常0〜数件で問題にならない。
 *   将来ボリュームが増えたら que_id-in でのまとめ照会に切り替える余地あり（現状は書式確証がないため eq を採用）。
 *
 * ★トークン: advanceQueuedCard→checkQueStatus は access/refresh のみで動く（client_id/secret 不要）。
 *   よってこの関数に Secret Manager の注入は不要。Firestore(neAuth/tokens) のトークンを使う。
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { REGION, NE_STATUS } from "../config/constants";
import { isNeAutoConfigured } from "../config/env";
import { giftCardsRef } from "../lib/firestore";
import { advanceQueuedCard } from "../ne/submit";

/** 1回の実行で確認する最大 queued 件数（暴発防止）。超過分は次回tickで処理。 */
const ADVANCE_LIMIT = 500;

/** 実行間隔。queued が無ければ叩かない設計なので短くしても回数は増えない。即時性と Scheduler 実行コストのバランスで15分。 */
const SCHEDULE = "every 15 minutes";

export const neAdvanceQueued = onSchedule(
  { schedule: SCHEDULE, region: REGION, timeZone: "Asia/Tokyo" },
  async () => {
    // auto 以外（manual/csv/未設定）は自動確定しない。
    if (!isNeAutoConfigured()) {
      logger.debug("neAdvanceQueued: auto not configured; skip");
      return;
    }

    // ★queued が1件も無ければ NE API を叩かずに終了（Firestore 読み取りのみ）。
    const snap = await giftCardsRef
      .where("neStatus", "==", NE_STATUS.QUEUED)
      .limit(ADVANCE_LIMIT)
      .get();
    if (snap.empty) {
      logger.debug("neAdvanceQueued: no queued cards; skip (no NE API call)");
      return;
    }

    // queued の各カードを que_id で確認して確定（submitted / pending へ）。
    let submitted = 0, failed = 0, waiting = 0, skipped = 0;
    for (const doc of snap.docs) {
      const r = await advanceQueuedCard(doc.id);
      if (r === "submitted") submitted++;
      else if (r === "failed") failed++;
      else if (r === "waiting") waiting++;
      else skipped++;
    }
    logger.info("neAdvanceQueued", { total: snap.size, submitted, failed, waiting, skipped });
  },
);

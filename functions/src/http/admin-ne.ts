/**
 * 管理API: NE連携（CSV出力 / 手動リトライ・段階投入）（design.md 第6章・4.1「受注確認」）
 *
 * - adminExportNeCsv: 未投入（status:used かつ neStatus:pending）の確定受注を Shift_JIS CSV で出力。
 *   ?markExported=1 を付けると、出力した分を neStatus:csv に更新（＝取込済み扱い・二重取込防止）。
 * - adminRetryNeSubmissions: 自動投入が有効なとき、pending を（受注伝票アップロードAPIへ）投入し、queued を
 *   キュー確認で前進させる。**?cardId=<id> で1件だけ / ?limit=N で件数を絞れる**（段階テスト用）。
 *   非同期キューのため、1件テストは「1回目=アップロード(pending→queued) → もう1回=キュー確認(queued→submitted)」の
 *   2回叩きで確定する。
 *
 * 認証: Firebase Auth IDトークン（requireAuth）。
 * ★新規HTTP関数は増やしていない（既存 adminRetryNeSubmissions の拡張）＝Cloud Run 手動public設定の追加は不要。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { CARD_STATUS, NE_STATUS } from "../config/constants";
import { HTTP_OPTIONS } from "./options";
import { isNeSubmitEnabled } from "../config/env";
import { db, giftCardsRef, selectableProductsRef } from "../lib/firestore";
import { GiftCardData } from "../models";
import { buildNeCsvBuffer } from "../ne/csv";
import { giftCardToNeCsvRow } from "../ne/rows";
import { trySubmitCard, advanceQueuedCard } from "../ne/submit";
import { applyCors } from "./cors";
import { requireAuth } from "./guard";

const EXPORT_LIMIT = 5000; // 1回のCSV/リトライで扱う最大件数（暴発防止）。

type CardHit = { id: string; data: GiftCardData };

// used かつ 指定 neStatus のカードを usedAt 昇順で取得。
async function fetchByNeStatus(neStatus: string, limit: number): Promise<CardHit[]> {
  const snap = await giftCardsRef
    .where("status", "==", CARD_STATUS.USED)
    .where("neStatus", "==", neStatus)
    .orderBy("usedAt", "asc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

// 未投入（used かつ pending）を取得（CSV出力で使用）。
async function fetchPending(limit = EXPORT_LIMIT): Promise<CardHit[]> {
  return fetchByNeStatus(NE_STATUS.PENDING, limit);
}

/**
 * GET /api/adminExportNeCsv[?markExported=1]
 *   res: text/csv（Shift_JIS）。対象0件でもヘッダ行のみの空CSVを返す。
 */
export const adminExportNeCsv = onRequest(HTTP_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  try {
    const pending = await fetchPending();

    // 商品をまとめて解決（N+1回避）。
    const productIds = [...new Set(pending.map((p) => p.data.selectedProductId).filter(Boolean) as string[])];
    const productSnaps = productIds.length ? await db.getAll(...productIds.map((id) => selectableProductsRef.doc(id))) : [];
    const productById = new Map(productSnaps.map((s) => [s.id, s.data()]));

    // 実証済みの41列マッピング（管理画面CSVとAPI投入で共通 / ne/rows.ts）。
    const rows = pending.map(({ data }) => {
      const prod = data.selectedProductId ? productById.get(data.selectedProductId) : undefined;
      return giftCardToNeCsvRow(data, prod ? { name: prod.name, neProductCode: prod.neProductCode } : undefined);
    });

    // 出力分を取込済み（csv）に更新する場合（二重取込防止）。
    const mark = req.query.markExported === "1" || req.query.markExported === "true";
    if (mark && pending.length) {
      for (let i = 0; i < pending.length; i += 500) {
        const batch = db.batch();
        for (const p of pending.slice(i, i + 500)) {
          batch.update(giftCardsRef.doc(p.id), { neStatus: NE_STATUS.CSV_EXPORTED });
        }
        await batch.commit();
      }
    }

    const buf = buildNeCsvBuffer(rows);
    res.set("Content-Type", "text/csv; charset=Shift_JIS");
    // ファイル名に「店舗2」を明記（NE取り込み時に店舗2の受注一括登録パターンで取り込む運用を示す）。
    res.set("Content-Disposition", 'attachment; filename="ne-orders-shop2.csv"');
    res.status(200).send(buf);
    logger.info("adminExportNeCsv", { count: rows.length, marked: mark });
  } catch (err) {
    logger.error("adminExportNeCsv failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

/**
 * POST /api/adminRetryNeSubmissions[?cardId=<id>][?limit=N]
 *   自動投入が有効なとき、pending をアップロード投入（→queued）し、queued をキュー確認（→submitted/pending）する。
 *   - ?cardId=<id>: そのカード1件だけを対象（段階テスト用）。
 *   - ?limit=N: 対象件数の上限（既定 EXPORT_LIMIT。1件テストは ?limit=1）。
 *   res: { ok, configured, submitted, queued, failed, waiting, skipped }
 */
export const adminRetryNeSubmissions = onRequest(HTTP_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  // 手動投入は auto / manual のどちらでも許可（manual＝自動トリガーは動かさず手動投入だけ）。
  if (!isNeSubmitEnabled()) {
    res.status(200).json({ ok: true, configured: false, submitted: 0, queued: 0, failed: 0, waiting: 0, skipped: 0 });
    return;
  }

  try {
    const cardId = typeof req.query.cardId === "string" ? req.query.cardId : "";
    const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), EXPORT_LIMIT) : EXPORT_LIMIT;

    // 対象カード（cardId 指定なら1件、なければ pending＋queued を集める）。
    let targets: CardHit[];
    if (cardId) {
      const snap = await giftCardsRef.doc(cardId).get();
      targets = snap.exists ? [{ id: snap.id, data: snap.data() as GiftCardData }] : [];
    } else {
      const pending = await fetchByNeStatus(NE_STATUS.PENDING, limit);
      const queued = await fetchByNeStatus(NE_STATUS.QUEUED, limit);
      targets = [...pending, ...queued].slice(0, limit);
    }

    let submitted = 0, queued = 0, failed = 0, waiting = 0, skipped = 0;
    for (const t of targets) {
      const st = t.data.neStatus;
      if (st === NE_STATUS.PENDING) {
        const r = await trySubmitCard(t.id);
        if (r === "queued") queued++;
        else if (r === "failed") failed++;
        else skipped++;
      } else if (st === NE_STATUS.QUEUED) {
        const r = await advanceQueuedCard(t.id);
        if (r === "submitted") submitted++;
        else if (r === "failed") failed++;
        else if (r === "waiting") waiting++;
        else skipped++;
      } else {
        skipped++;
      }
    }
    logger.info("adminRetryNeSubmissions", { cardId: cardId || null, total: targets.length, submitted, queued, failed, waiting, skipped });
    res.status(200).json({ ok: true, configured: true, submitted, queued, failed, waiting, skipped });
  } catch (err) {
    logger.error("adminRetryNeSubmissions failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

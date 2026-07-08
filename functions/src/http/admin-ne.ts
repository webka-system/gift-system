/**
 * 管理API: NE連携（CSV出力 / 手動リトライ）（design.md 第6章・4.1「受注確認」）
 *
 * - adminExportNeCsv: 未投入（status:used かつ neStatus:pending）の確定受注を Shift_JIS CSV で出力。
 *   ?markExported=1 を付けると、出力した分を neStatus:csv に更新（＝取込済み扱い・二重取込防止）。
 * - adminRetryNeSubmissions: 自動投入が有効なとき、pending の確定受注をまとめて再投入する
 *   （失敗して pending に残ったもののリトライ経路。scheduled から呼ぶ形にも将来拡張可能）。
 *
 * 認証: Firebase Auth IDトークン（requireAuth）。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { REGION, CARD_STATUS, NE_STATUS } from "../config/constants";
import { isNeAutoConfigured } from "../config/env";
import { db, giftCardsRef, giftCardTypesRef, selectableProductsRef } from "../lib/firestore";
import { GiftCardData } from "../models";
import { NeCsvRow, buildNeCsvBuffer } from "../ne/csv";
import { trySubmitCard } from "../ne/submit";
import { applyCors } from "./cors";
import { requireAuth } from "./guard";

const EXPORT_LIMIT = 5000; // 1回のCSV/リトライで扱う最大件数（暴発防止）。

// 未投入（used かつ pending）を usedAt 昇順で取得。
async function fetchPending(): Promise<{ id: string; data: GiftCardData }[]> {
  const snap = await giftCardsRef
    .where("status", "==", CARD_STATUS.USED)
    .where("neStatus", "==", NE_STATUS.PENDING)
    .orderBy("usedAt", "asc")
    .limit(EXPORT_LIMIT)
    .get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

function fmtDate(ts: unknown): string {
  const t = ts as { toDate?: () => Date } | undefined;
  if (t && typeof t.toDate === "function") return t.toDate().toISOString();
  return "";
}

/**
 * GET /api/adminExportNeCsv[?markExported=1]
 *   res: text/csv（Shift_JIS）。対象0件でもヘッダ行のみの空CSVを返す。
 */
export const adminExportNeCsv = onRequest({ region: REGION }, async (req, res) => {
  applyCors(req.headers, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  try {
    const pending = await fetchPending();

    // 商品・種別名をまとめて解決（N+1回避）。
    const productIds = [...new Set(pending.map((p) => p.data.selectedProductId).filter(Boolean) as string[])];
    const typeIds = [...new Set(pending.map((p) => p.data.cardTypeId).filter(Boolean))];
    const productSnaps = productIds.length ? await db.getAll(...productIds.map((id) => selectableProductsRef.doc(id))) : [];
    const typeSnaps = typeIds.length ? await db.getAll(...typeIds.map((id) => giftCardTypesRef.doc(id))) : [];
    const productById = new Map(productSnaps.map((s) => [s.id, s.data()]));
    const typeById = new Map(typeSnaps.map((s) => [s.id, s.data()]));

    const rows: NeCsvRow[] = pending.map(({ data }) => {
      const prod = data.selectedProductId ? productById.get(data.selectedProductId) : undefined;
      const type = typeById.get(data.cardTypeId);
      const a = data.shippingAddress;
      return {
        token: data.token,
        cardTypeName: type?.name || data.cardTypeId,
        productName: prod?.name || "",
        neProductCode: prod?.neProductCode || "",
        quantity: 1,
        name: a?.name || "",
        postalCode: a?.postalCode || "",
        prefecture: a?.prefecture || "",
        address: a?.address || "",
        building: a?.building || "",
        phone: a?.phone || "",
        usedAt: fmtDate(data.usedAt),
        memo: data.memo || "",
      };
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
    res.set("Content-Disposition", 'attachment; filename="ne-orders.csv"');
    res.status(200).send(buf);
    logger.info("adminExportNeCsv", { count: rows.length, marked: mark });
  } catch (err) {
    logger.error("adminExportNeCsv failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

/**
 * POST /api/adminRetryNeSubmissions
 *   自動投入が有効なとき、pending の確定受注をまとめて再投入。
 *   res: { ok:true, configured:boolean, submitted:number, failed:number, skipped:number }
 */
export const adminRetryNeSubmissions = onRequest({ region: REGION }, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  if (!isNeAutoConfigured()) {
    res.status(200).json({ ok: true, configured: false, submitted: 0, failed: 0, skipped: 0 });
    return;
  }

  try {
    const pending = await fetchPending();
    let submitted = 0, failed = 0, skipped = 0;
    for (const p of pending) {
      const r = await trySubmitCard(p.id);
      if (r === "submitted") submitted++;
      else if (r === "failed") failed++;
      else skipped++;
    }
    logger.info("adminRetryNeSubmissions", { total: pending.length, submitted, failed, skipped });
    res.status(200).json({ ok: true, configured: true, submitted, failed, skipped });
  } catch (err) {
    logger.error("adminRetryNeSubmissions failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

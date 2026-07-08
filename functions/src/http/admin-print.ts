/**
 * 管理API: 印刷用QR面付けPDFの出力（design.md 4.1「印刷用出力」/ 第9章 手順7）
 *
 * 対象カードを選んで（種別ごと / 未印刷分だけ）、受け取り者URL（/g/<token>）のQRを面付けした
 * 印刷用PDFを返す。?markPrinted=1 で出力分を印刷済み（printed:true / printedAt）に更新する。
 *
 * 認証: Firebase Auth IDトークン（requireAuth）。PDF生成はサーバ側（pdf-lib + qrcode）。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { REGION, PRINT } from "../config/constants";
import { publicHostingOrigin } from "../config/env";
import { db, giftCardsRef } from "../lib/firestore";
import { buildCardUrl } from "../lib/url";
import { GiftCardData } from "../models";
import { buildQrSheetPdf, QrItem } from "../pdf/qr-sheet";
import { applyCors } from "./cors";
import { requireAuth } from "./guard";

/**
 * GET /api/adminExportQrPdf?cardTypeId=...&unprintedOnly=1&markPrinted=1
 *   res: application/pdf（面付け済み）。対象0件でも案内文1ページのPDFを返す。
 */
export const adminExportQrPdf = onRequest({ region: REGION }, async (req, res) => {
  applyCors(req.headers, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  const cardTypeId = typeof req.query.cardTypeId === "string" ? req.query.cardTypeId.trim() : "";
  const unprintedOnly = req.query.unprintedOnly === "1" || req.query.unprintedOnly === "true";
  const markPrinted = req.query.markPrinted === "1" || req.query.markPrinted === "true";

  try {
    // 対象カードを抽出（種別 / 未印刷 でフィルタ）。並び順はメモリ側で createdAt 昇順に安定化。
    let q: FirebaseFirestore.Query<GiftCardData> = giftCardsRef;
    if (cardTypeId) q = q.where("cardTypeId", "==", cardTypeId);
    if (unprintedOnly) q = q.where("printed", "==", false);
    const snap = await q.limit(PRINT.MAX_CARDS_PER_PDF).get();

    const docs = snap.docs.slice().sort((a, b) => {
      const ta = a.data().createdAt?.toMillis?.() ?? 0;
      const tb = b.data().createdAt?.toMillis?.() ?? 0;
      return ta - tb;
    });

    const origin = publicHostingOrigin();
    const items: QrItem[] = docs.map((d) => ({ token: d.data().token, url: buildCardUrl(origin, d.data().token) }));

    const pdfBytes = await buildQrSheetPdf(items);

    // 出力分を印刷済みに更新（任意）。
    if (markPrinted && docs.length) {
      for (let i = 0; i < docs.length; i += 500) {
        const batch = db.batch();
        for (const d of docs.slice(i, i + 500)) {
          batch.update(d.ref, { printed: true, printedAt: FieldValue.serverTimestamp() });
        }
        await batch.commit();
      }
    }

    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", 'attachment; filename="qr-cards.pdf"');
    res.status(200).send(Buffer.from(pdfBytes));
    logger.info("adminExportQrPdf", { count: items.length, cardTypeId: cardTypeId || null, unprintedOnly, markPrinted });
  } catch (err) {
    logger.error("adminExportQrPdf failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

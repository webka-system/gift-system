/**
 * 管理API: 印刷工場入稿用 URL一覧の Excel(xlsx) 出力（design.md 4.1「印刷用出力」/ 第9章 手順7）
 *
 * 対象カード（種別ごと / 未印刷分だけ）の受け取り者URL（/g/<token>）を1行ずつ並べた xlsx を返す。
 * ?markPrinted=1 で出力分を印刷済み（printed:true / printedAt）に更新する。
 * ?urlOnly=1 で A列(URL)のみの構成に切り替え（工場が純URL列だけを求める場合）。
 *
 * 認証: Firebase Auth IDトークン（requireAuth）。xlsx生成はサーバ側（exceljs）。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { REGION, URL_EXPORT } from "../config/constants";
import { publicHostingOrigin } from "../config/env";
import { db, giftCardsRef, giftCardTypesRef } from "../lib/firestore";
import { buildCardUrl } from "../lib/url";
import { GiftCardData } from "../models";
import { UrlRow, buildUrlListXlsx } from "../xlsx/url-list";
import { applyCors } from "./cors";
import { requireAuth } from "./guard";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * GET /api/adminExportUrlXlsx?cardTypeId=...&unprintedOnly=1&markPrinted=1&urlOnly=1
 *   res: xlsx（各行に受け取り者URL）。対象0件でも（ヘッダのみ／空の）xlsxを返す。
 */
export const adminExportUrlXlsx = onRequest({ region: REGION }, async (req, res) => {
  applyCors(req.headers, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const admin = await requireAuth(req, res);
  if (!admin) return;

  const cardTypeId = typeof req.query.cardTypeId === "string" ? req.query.cardTypeId.trim() : "";
  const unprintedOnly = req.query.unprintedOnly === "1" || req.query.unprintedOnly === "true";
  const markPrinted = req.query.markPrinted === "1" || req.query.markPrinted === "true";
  const urlOnly = req.query.urlOnly === "1" || req.query.urlOnly === "true" ? true : undefined;

  try {
    // 対象カードを抽出（種別 / 未印刷 でフィルタ）。並び順はメモリ側で createdAt 昇順に安定化。
    let q: FirebaseFirestore.Query<GiftCardData> = giftCardsRef;
    if (cardTypeId) q = q.where("cardTypeId", "==", cardTypeId);
    if (unprintedOnly) q = q.where("printed", "==", false);
    const snap = await q.limit(URL_EXPORT.MAX_ROWS).get();

    const docs = snap.docs.slice().sort((a, b) => {
      const ta = a.data().createdAt?.toMillis?.() ?? 0;
      const tb = b.data().createdAt?.toMillis?.() ?? 0;
      return ta - tb;
    });

    // 種別名をまとめて解決（N+1回避）。
    const typeIds = [...new Set(docs.map((d) => d.data().cardTypeId).filter(Boolean))];
    const typeSnaps = typeIds.length ? await db.getAll(...typeIds.map((id) => giftCardTypesRef.doc(id))) : [];
    const typeNameById = new Map(typeSnaps.map((s) => [s.id, s.data()?.name || s.id]));

    const origin = publicHostingOrigin();
    const rows: UrlRow[] = docs.map((d) => {
      const c = d.data();
      return {
        url: buildCardUrl(origin, c.token),
        token: c.token,
        cardTypeName: typeNameById.get(c.cardTypeId) || c.cardTypeId,
      };
    });

    const buf = await buildUrlListXlsx(rows, { urlOnly });

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

    res.set("Content-Type", XLSX_MIME);
    res.set("Content-Disposition", 'attachment; filename="qr-urls.xlsx"');
    res.status(200).send(buf);
    logger.info("adminExportUrlXlsx", { count: rows.length, cardTypeId: cardTypeId || null, unprintedOnly, markPrinted, urlOnly: !!urlOnly });
  } catch (err) {
    logger.error("adminExportUrlXlsx failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

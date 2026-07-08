/**
 * 印刷用QR面付けPDFの生成（design.md 4.1「印刷用出力」/ 第9章 手順7）
 *
 * サーバ側（Cloud Functions）で pdf-lib + qrcode を使って生成する（label-system 準拠）。
 * 各QRは受け取り者URL（/g/<token>）をエンコードし、スマホで読むと受け取り者画面に着地する。
 *
 * レイアウトは shared/constants.js の PRINT を既定オプションとして受け取り、全パラメータを
 * 差し替え可能にしてある（工場入稿仕様が確定したら定数変更だけで対応できる）。
 */

import { PDFDocument, PDFPage, StandardFonts, PDFFont, rgb } from "pdf-lib";
import * as QRCode from "qrcode";
import { PRINT } from "../config/constants";

const MM_TO_PT = 72 / 25.4;
const mm = (v: number) => v * MM_TO_PT;

export type QrSheetOptions = typeof PRINT;

/** 1枚分の入力（トークンとそのQRにエンコードするURL）。 */
export interface QrItem {
  token: string;
  url: string;
}

/**
 * URL から高解像度のQR PNGを生成する（buildQrSheetPdf が埋め込むのと同一の関数）。
 * クワイエットゾーン（margin）と誤り訂正レベルは読み取り信頼性優先の既定。
 */
export function renderQrPng(url: string, opts: QrSheetOptions = PRINT): Promise<Buffer> {
  const px = Math.max(64, Math.round((opts.QR_SIZE_MM / 25.4) * opts.QR_RENDER_DPI));
  return QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: opts.QR_ERROR_CORRECTION as QRCode.QRCodeErrorCorrectionLevel,
    margin: opts.QR_QUIET_ZONE_MODULES,
    width: px,
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
}

/** ページ四隅にトンボ（トリム位置の目印）を引く。CROP_MARKS 有効時のみ。 */
function drawCropMarks(page: PDFPage, opts: QrSheetOptions, pageW: number, pageH: number) {
  const b = mm(opts.BLEED_MM);
  const len = mm(4); // トンボ線の長さ
  const c = rgb(0, 0, 0);
  const trim = [
    { x: b, y: b }, // 左下（トリム角）
    { x: pageW - b, y: b },
    { x: b, y: pageH - b },
    { x: pageW - b, y: pageH - b },
  ];
  for (const p of trim) {
    const sx = p.x === b ? -1 : 1;
    const sy = p.y === b ? -1 : 1;
    page.drawLine({ start: { x: p.x, y: p.y }, end: { x: p.x + sx * len, y: p.y }, thickness: 0.3, color: c });
    page.drawLine({ start: { x: p.x, y: p.y }, end: { x: p.x, y: p.y + sy * len }, thickness: 0.3, color: c });
  }
}

/**
 * QRを面付けした印刷用PDFを生成する。items が空なら案内文の1ページを返す。
 * 返り値は PDF バイト列（Uint8Array）。
 */
export async function buildQrSheetPdf(items: QrItem[], opts: QrSheetOptions = PRINT): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font: PDFFont = await pdf.embedFont(StandardFonts.Helvetica);

  const pageW = mm(opts.PAGE_W_MM + 2 * opts.BLEED_MM);
  const pageH = mm(opts.PAGE_H_MM + 2 * opts.BLEED_MM);
  const margin = mm(opts.MARGIN_MM) + mm(opts.BLEED_MM);
  const gutter = mm(opts.GUTTER_MM);
  const qrSize = mm(opts.QR_SIZE_MM);
  const labelPt = opts.TOKEN_LABEL_PT;
  const labelGap = opts.SHOW_TOKEN_LABEL ? labelPt + mm(1.5) : 0;

  if (items.length === 0) {
    // 空ページの案内文は ASCII のみ（標準フォント Helvetica は日本語を埋め込めないため。
    // トークン文字は base64url=ASCII なので本文QRラベルは Helvetica で問題ない）。
    const page = pdf.addPage([pageW, pageH]);
    page.drawText("No cards matched the selection.", { x: margin, y: pageH - margin - 12, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
    return pdf.save();
  }

  const perPage = opts.COLUMNS * opts.ROWS;
  const gridW = pageW - 2 * margin;
  const gridH = pageH - 2 * margin;
  const cellW = (gridW - gutter * (opts.COLUMNS - 1)) / opts.COLUMNS;
  const cellH = (gridH - gutter * (opts.ROWS - 1)) / opts.ROWS;
  const contentH = qrSize + labelGap; // QR＋ラベルの高さ
  let page: PDFPage | null = null;

  for (let i = 0; i < items.length; i++) {
    if (i % perPage === 0) {
      page = pdf.addPage([pageW, pageH]);
      if (opts.CROP_MARKS) drawCropMarks(page, opts, pageW, pageH);
    }
    const idx = i % perPage;
    const col = idx % opts.COLUMNS;
    const row = Math.floor(idx / opts.COLUMNS);

    // セル左上（PDFは左下原点なので y は上端）。
    const cellX = margin + col * (cellW + gutter);
    const cellTopY = pageH - margin - row * (cellH + gutter);

    // セル内でコンテンツ（QR＋ラベル）を縦横中央寄せ。
    const contentTopY = cellTopY - (cellH - contentH) / 2;
    const qrX = cellX + (cellW - qrSize) / 2;
    const qrBottomY = contentTopY - qrSize; // drawImage の y は画像の下端

    const png = await pdf.embedPng(await renderQrPng(items[i].url, opts));
    page!.drawImage(png, { x: qrX, y: qrBottomY, width: qrSize, height: qrSize });

    if (opts.SHOW_TOKEN_LABEL) {
      const text = items[i].token;
      const tw = font.widthOfTextAtSize(text, labelPt);
      const tx = cellX + (cellW - Math.min(tw, cellW)) / 2;
      page!.drawText(text, { x: tx, y: qrBottomY - labelPt - mm(0.8), size: labelPt, font, color: rgb(0, 0, 0), maxWidth: cellW, lineHeight: labelPt });
    }
  }

  return pdf.save();
}

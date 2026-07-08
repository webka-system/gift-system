/**
 * pdf/qr-sheet の単体テスト。
 *   - renderQrPng が生成するQR PNG（＝PDFに埋め込まれるのと同一バイト）を jsqr で実際にデコードし、
 *     /g/<token> URL を正しく指し「読み取り可能」であることを検証する。
 *   - buildQrSheetPdf が有効なPDF・正しいページ数を返すことを検証する。
 */

import * as assert from "node:assert";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";
import { renderQrPng, buildQrSheetPdf, QrItem } from "../src/pdf/qr-sheet";
import { buildCardUrl } from "../src/lib/url";
import { PRINT } from "../src/config/constants";

// QR PNG を jsqr でデコードして中身の文字列を返す。
function decodeQrPng(png: Buffer): string | null {
  const img = PNG.sync.read(png);
  const r = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  return r ? r.data : null;
}

describe("renderQrPng / QR 読み取り", () => {
  it("生成したQRを実際にデコードすると /g/<token> URL に一致する（読み取り可能）", async () => {
    const origin = "https://gift-system-f33b5.web.app";
    const token = "Ab3-_xYz9KqLmN0pQrStUvWx"; // base64url 相当のサンプル
    const url = buildCardUrl(origin, token);
    const png = await renderQrPng(url);
    const decoded = decodeQrPng(png);
    assert.strictEqual(decoded, url, "QRのデコード結果がURLと一致すること");
    assert.ok(url.includes(`/g/${token}`), "URLが /g/<token> 形式であること");
  });

  it("長め（実運用相当）のトークンURLでもデコードできる", async () => {
    const url = buildCardUrl("https://gift-system-f33b5.web.app", "Zm9vYmFyYmF6cXV4ThisIsA32charTok");
    const decoded = decodeQrPng(await renderQrPng(url));
    assert.strictEqual(decoded, url);
  });
});

describe("buildQrSheetPdf", () => {
  const items = (n: number): QrItem[] =>
    Array.from({ length: n }, (_, i) => ({ token: `tok${i}`, url: buildCardUrl("https://ex.test", `tok${i}`) }));

  it("有効なPDF（%PDFヘッダ）を返す", async () => {
    const bytes = await buildQrSheetPdf(items(3));
    const head = Buffer.from(bytes.slice(0, 5)).toString("latin1");
    assert.strictEqual(head, "%PDF-");
  });

  it("面付け枚数に応じたページ数になる（perPage で改ページ）", async () => {
    const perPage = PRINT.COLUMNS * PRINT.ROWS; // 12
    for (const [n, expected] of [[1, 1], [perPage, 1], [perPage + 1, 2], [perPage * 2 + 3, 3]] as const) {
      const doc = await PDFDocument.load(await buildQrSheetPdf(items(n)));
      assert.strictEqual(doc.getPageCount(), expected, `${n}枚 → ${expected}ページ`);
    }
  });

  it("0件でも案内文1ページのPDFを返す", async () => {
    const doc = await PDFDocument.load(await buildQrSheetPdf([]));
    assert.strictEqual(doc.getPageCount(), 1);
  });
});

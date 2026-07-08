/**
 * xlsx/url-list の単体テスト。生成した xlsx を exceljs で読み戻して構成を検証する。
 */

import * as assert from "node:assert";
import ExcelJS from "exceljs";
import { buildUrlListXlsx, UrlRow } from "../src/xlsx/url-list";

const rows: UrlRow[] = [
  { url: "https://gift-system-f33b5.web.app/g/tok-a", token: "tok-a", cardTypeName: "3万円" },
  { url: "https://gift-system-f33b5.web.app/g/tok-b", token: "tok-b", cardTypeName: "1万円" },
];

async function load(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  // exceljs の load は Buffer/ArrayBuffer を受ける。@types/node の Buffer ジェネリクス差異を吸収するため cast。
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets[0];
}

describe("buildUrlListXlsx", () => {
  it("既定: A=URL / B=token / C=種別名（ヘッダ行あり）", async () => {
    const ws = await load(await buildUrlListXlsx(rows, { urlOnly: false, includeHeader: true }));
    assert.strictEqual(ws.getCell("A1").value, "URL");
    assert.strictEqual(ws.getCell("B1").value, "token");
    assert.strictEqual(ws.getCell("C1").value, "種別名");
    // データはヘッダの次行から。
    assert.strictEqual(ws.getCell("A2").value, rows[0].url);
    assert.strictEqual(ws.getCell("B2").value, "tok-a");
    assert.strictEqual(ws.getCell("C2").value, "3万円");
    assert.strictEqual(ws.getCell("A3").value, rows[1].url);
  });

  it("urlOnly: A列(URL)のみ", async () => {
    const ws = await load(await buildUrlListXlsx(rows, { urlOnly: true, includeHeader: true }));
    assert.strictEqual(ws.getCell("A1").value, "URL");
    assert.strictEqual(ws.getCell("B1").value, null);
    assert.strictEqual(ws.getCell("A2").value, rows[0].url);
  });

  it("ヘッダ無し: A1 から純粋なURLが並ぶ（工場が純URL列を求める場合）", async () => {
    const ws = await load(await buildUrlListXlsx(rows, { urlOnly: true, includeHeader: false }));
    assert.strictEqual(ws.getCell("A1").value, rows[0].url);
    assert.strictEqual(ws.getCell("A2").value, rows[1].url);
  });

  it("各行が1つのURLを持つ（行数＝データ件数＋ヘッダ）", async () => {
    const ws = await load(await buildUrlListXlsx(rows, { urlOnly: false, includeHeader: true }));
    assert.strictEqual(ws.rowCount, rows.length + 1);
  });
});

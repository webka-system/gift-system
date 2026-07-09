/**
 * ne/csv の単体テスト（CSV整形・Shift_JIS エンコード）。
 */

import * as assert from "node:assert";
import * as iconv from "iconv-lite";
import { NeCsvRow, buildNeCsvString, toShiftJisBuffer, NE_CSV_COLUMNS } from "../src/ne/csv";

function row(overrides: Partial<NeCsvRow> = {}): NeCsvRow {
  return {
    slipNo: "tok1", orderDate: "2026-07-08", name: "山田太郎", nameKana: "ヤマダタロウ",
    postalCode: "1234567", address: "東京都 千代田区1-1 101", phone: "0312345678",
    email: "taro@example.com", productName: "商品A", neProductCode: "NE-A", quantity: 1,
    deliveryDate: "", deliveryTime: "", cardTypeName: "3万円", memo: "",
    ...overrides,
  };
}

describe("buildNeCsvString", () => {
  it("ヘッダ行＋データ行を CRLF で出力する", () => {
    const csv = buildNeCsvString([row()]);
    const lines = csv.split("\r\n");
    assert.strictEqual(lines[0], NE_CSV_COLUMNS.map((c) => c.header).join(","));
    assert.ok(lines[1].includes("NE-A"));
    assert.ok(lines[1].includes("山田太郎"));
  });

  it("カンマ・引用符・改行を含む値を正しくエスケープする", () => {
    const csv = buildNeCsvString([row({ address: 'A,B "C"', memo: "line1\nline2" })]);
    assert.ok(csv.includes('"A,B ""C"""'), "comma/quote escaped");
    assert.ok(csv.includes('"line1\nline2"'), "newline quoted");
  });

  it("0件でもヘッダ行のみを返す", () => {
    const csv = buildNeCsvString([]);
    assert.strictEqual(csv.trim(), NE_CSV_COLUMNS.map((c) => c.header).join(","));
  });
});

describe("toShiftJisBuffer", () => {
  it("Shift_JIS でエンコードされ、デコードで元に戻る", () => {
    const csv = buildNeCsvString([row()]);
    const buf = toShiftJisBuffer(csv);
    // Shift_JIS の漢字は2バイト。UTF-8(3バイト/字)とはバイト長が異なる＝SJISで出ている証拠。
    assert.ok(buf.length < Buffer.byteLength(csv, "utf8"));
    const back = iconv.decode(buf, "Shift_JIS");
    assert.ok(back.includes("山田太郎"));
    assert.ok(back.includes("東京都"));
  });
});

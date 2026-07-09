/**
 * ne/csv の単体テスト（CSV整形・Shift_JIS エンコード）。
 */

import * as assert from "node:assert";
import * as iconv from "iconv-lite";
import { NeCsvRow, buildNeCsvString, toShiftJisBuffer, NE_CSV_COLUMNS } from "../src/ne/csv";

function row(overrides: Partial<NeCsvRow> = {}): NeCsvRow {
  return {
    slipNo: "tok1", orderDate: "2026/07/08 10:00:00",
    postalCode: "2500011", address1: "神奈川県小田原市栄町2-7-25", address2: "4F",
    name: "山田太郎", nameKana: "ヤマダタロウ", phone: "0312345678",
    email: "taro@example.com", productName: "商品A", neProductCode: "NE-A",
    deliveryDate: "", deliveryTime: "", memo: "",
    ...overrides,
  };
}

// NEサンプルCSVから確定した正解ヘッダー（41列・この順序・一字一句一致）。
const EXPECTED_HEADER =
  "店舗伝票番号,受注日,受注郵便番号,受注住所１,受注住所２,受注名,受注名カナ,受注電話番号,受注メールアドレス," +
  "発送郵便番号,発送先住所１,発送先住所２,発送先名,発送先カナ,発送電話番号,支払方法,発送方法," +
  "商品計,税金,発送料,手数料,ポイント,その他費用,合計金額,ギフトフラグ,時間帯指定,日付指定,作業者欄,備考," +
  "商品名,商品コード,商品価格,受注数量,商品オプション,出荷済フラグ,顧客区分,顧客コード,消費税率（%）,のし,ラッピング,メッセージ";

describe("buildNeCsvString", () => {
  it("ヘッダー行が NE 正解の41列と一字一句一致する", () => {
    assert.strictEqual(NE_CSV_COLUMNS.length, 41);
    const csv = buildNeCsvString([row()]);
    const lines = csv.split("\r\n");
    assert.strictEqual(lines[0], EXPECTED_HEADER);
  });

  it("受注住所１が空にならない（住所1=都道府県+住所）", () => {
    const csv = buildNeCsvString([row()]);
    const cells = csv.split("\r\n")[1].split(",");
    assert.strictEqual(cells[3], "神奈川県小田原市栄町2-7-25"); // 受注住所１
    assert.notStrictEqual(cells[3], "");
  });

  it("時間帯指定は「時間帯指定[○○]」形式、未指定は空", () => {
    const withTime = buildNeCsvString([row({ deliveryTime: "14:00-16:00" })]).split("\r\n")[1].split(",");
    assert.strictEqual(withTime[25], "時間帯指定[14時-16時]"); // 26列目=時間帯指定
    const noTime = buildNeCsvString([row()]).split("\r\n")[1].split(",");
    assert.strictEqual(noTime[25], "");
  });

  it("データ行に主要値が入る", () => {
    const csv = buildNeCsvString([row()]);
    const lines = csv.split("\r\n");
    assert.ok(lines[1].includes("NE-A"));
    assert.ok(lines[1].includes("山田太郎"));
  });

  it("カンマ・引用符・改行を含む値を正しくエスケープする", () => {
    const csv = buildNeCsvString([row({ address1: 'A,B "C"', memo: "line1\nline2" })]);
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
    assert.ok(back.includes("神奈川県小田原市栄町"));
  });
});

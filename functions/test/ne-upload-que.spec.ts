/**
 * ne/upload・ne/que・ne/rows の単体テスト（非同期キュー投入まわり）。
 * fetch とトークンストアを注入し、Firestore/NE 無しで挙動を固定する。
 */

import * as assert from "node:assert";
import * as iconv from "iconv-lite";
import { NeTokens, NeTokenStore } from "../src/ne/tokens";
import { uploadNeCsvRows } from "../src/ne/upload";
import { checkQueStatus, mapQueStatusId } from "../src/ne/que";
import { giftCardToNeCsvRow } from "../src/ne/rows";
import { NeCsvRow } from "../src/ne/csv";

function memStore(init: NeTokens): NeTokenStore & { current: NeTokens } {
  const s = {
    current: { ...init },
    async load() { return { ...s.current }; },
    async save(t: NeTokens) { s.current = { ...t }; },
  };
  return s;
}

function fakeFetch(responseJson: unknown, captured: { body?: string }) {
  return async (_url: string, init: { body: string }) => {
    captured.body = init.body;
    return {
      ok: true, status: 200,
      async json() { return responseJson; },
      async text() { return JSON.stringify(responseJson); },
    };
  };
}

function sampleRow(overrides: Partial<NeCsvRow> = {}): NeCsvRow {
  return {
    slipNo: "tok1", orderDate: "2026/07/08 10:00:00",
    postalCode: "2500011", address1: "神奈川県小田原市栄町2-7-25", address2: "4F",
    name: "山田太郎", nameKana: "ヤマダタロウ", phone: "0312345678",
    email: "taro@example.com", productName: "商品A", neProductCode: "NE-A",
    deliveryDate: "", deliveryTime: "", memo: "",
    ...overrides,
  };
}

describe("uploadNeCsvRows", () => {
  it("パターンID・data_type_1=csv・Shift-JIS CSV を送り、que_id を返す", async () => {
    const prev = process.env.NE_UPLOAD_PATTERN_ID;
    process.env.NE_UPLOAD_PATTERN_ID = "11";
    try {
      const store = memStore({ accessToken: "a", refreshToken: "r" });
      const cap: { body?: string } = {};
      const fetchFn = fakeFetch({ result: "success", que_id: "45" }, cap);

      const res = await uploadNeCsvRows([sampleRow()], { fetchFn, store });

      const body = cap.body || "";
      assert.strictEqual(res.queId, "45");
      assert.ok(body.includes("receive_order_upload_pattern_id=11"));
      assert.ok(body.includes("data_type_1=csv"));
      assert.ok(body.includes("wait_flag=1"));
      assert.ok(body.includes("data_1="));
      // data_1 は Shift-JIS を percent-encode したもの。デコードしてヘッダー行が復元できることを確認。
      const dataField = body.split("&").find((kv) => kv.startsWith("data_1="))!.slice("data_1=".length);
      const bytes = Buffer.from(dataField.replace(/%([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      const csv = iconv.decode(bytes, "Shift_JIS");
      assert.ok(csv.startsWith("店舗伝票番号,受注日,"), `decoded CSV header: ${csv.slice(0, 30)}`);
      assert.ok(csv.includes("山田太郎"));
    } finally {
      process.env.NE_UPLOAD_PATTERN_ID = prev;
    }
  });
});

describe("mapQueStatusId", () => {
  it("que_status_id を状態へ写像する（2=成功/1=処理中/0=待ち/-1=失敗）", () => {
    assert.strictEqual(mapQueStatusId("2"), "success");
    assert.strictEqual(mapQueStatusId("1"), "processing");
    assert.strictEqual(mapQueStatusId("0"), "waiting");
    assert.strictEqual(mapQueStatusId("-1"), "failed");
    assert.strictEqual(mapQueStatusId(""), "unknown");
  });
});

describe("checkQueStatus", () => {
  it("que_id で該当行を見つけ、status/message を返す", async () => {
    const store = memStore({ accessToken: "a", refreshToken: "r" });
    const cap: { body?: string } = {};
    const fetchFn = fakeFetch(
      { result: "success", data: [{ que_id: "45", que_status_id: "2", que_message: "ok" }] },
      cap,
    );

    const r = await checkQueStatus("45", { fetchFn, store });
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.status, "success");
    assert.strictEqual(r.statusId, "2");
    assert.strictEqual(r.message, "ok");
    // que_id-eq で絞り込む。
    assert.ok((cap.body || "").includes("que_id-eq=45"));
  });

  it("該当が無ければ found=false・unknown（queued 維持の安全側）", async () => {
    const store = memStore({ accessToken: "a", refreshToken: "r" });
    const cap: { body?: string } = {};
    const fetchFn = fakeFetch({ result: "success", data: [] }, cap);

    const r = await checkQueStatus("99", { fetchFn, store });
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.status, "unknown");
  });
});

describe("giftCardToNeCsvRow", () => {
  it("住所1=都道府県+住所・数字のみ・配達日スラッシュ化で変換する", () => {
    const card = {
      token: "tokX",
      usedAt: { toMillis: () => Date.UTC(2026, 6, 8, 1, 0, 0) }, // JST 10:00
      shippingAddress: {
        name: "田中花子", nameKana: "タナカハナコ",
        postalCode: "100-0001", prefecture: "東京都", address: "千代田区1-1", building: "801",
        phone: "03-1234-5678",
      },
      recipientEmail: "hanako@example.com",
      deliveryDate: "2026-07-25", deliveryTime: "午前中", memo: "m1",
    } as unknown as Parameters<typeof giftCardToNeCsvRow>[0];

    const r = giftCardToNeCsvRow(card, { name: "商品Z", neProductCode: "NE-Z" });
    assert.strictEqual(r.address1, "東京都千代田区1-1");
    assert.strictEqual(r.address2, "801");
    assert.strictEqual(r.postalCode, "1000001");
    assert.strictEqual(r.phone, "0312345678");
    assert.strictEqual(r.deliveryDate, "2026/07/25");
    assert.strictEqual(r.orderDate, "2026/07/08 10:00:00");
    assert.strictEqual(r.name, "田中花子");
    assert.strictEqual(r.neProductCode, "NE-Z");
    assert.strictEqual(r.memo, "m1");
  });
});

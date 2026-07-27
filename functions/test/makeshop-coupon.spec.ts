/**
 * makeshop/client・coupon の単体テスト（固定トークン方式）。
 * fetch を注入し、実 MakeShop 無しでヘッダー付与・レスポンス解釈・リトライ挙動を固定する。
 * ★フィールド名/enumは推定（実発行で直す前提）だが、「ヘッダーの乗せ方」「成否判定」「重複リトライ」は
 *   ここで固定して回帰を防ぐ。
 */

import * as assert from "node:assert";
import { makeshopGraphql } from "../src/makeshop/client";
import { generateCouponCode, createCouponRaw, createCouponWithRetry, reissueName } from "../src/makeshop/coupon";
import { COUPON } from "../src/config/constants";

// 環境変数（エンドポイント＋固定資格情報）をテスト用に用意する。
function withMakeshopEnv() {
  process.env.MAKESHOP_API_ENDPOINT = "https://api.example.test/graphql";
  process.env.MAKESHOP_ACCESS_TOKEN = "fixed-access-token";
  process.env.MAKESHOP_API_KEY = "fixed-api-key";
}

// 指定JSONを text() で返す fake fetch。呼び出し時の url/headers/body を記録する。
function fakeFetch(responseJson: unknown, cap: { url?: string; headers?: Record<string, string>; body?: string }) {
  return async (url: string, init: { headers: Record<string, string>; body: string }) => {
    cap.url = url;
    cap.headers = init.headers;
    cap.body = init.body;
    return { ok: true, status: 200, async text() { return JSON.stringify(responseJson); } };
  };
}

describe("makeshopGraphql（固定トークンのヘッダー付与）", () => {
  it("authorization: Bearer / x-api-key / x-timestamp / content-type を付けて POST する", async () => {
    withMakeshopEnv();
    const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const fetchFn = fakeFetch({ data: { ok: 1 } }, cap);

    await makeshopGraphql("query{ x }", { a: 1 }, { fetchFn, nowSeconds: 1700000000 });

    assert.strictEqual(cap.url, "https://api.example.test/graphql");
    assert.strictEqual(cap.headers?.["authorization"], "Bearer fixed-access-token");
    assert.strictEqual(cap.headers?.["x-api-key"], "fixed-api-key");
    assert.strictEqual(cap.headers?.["x-timestamp"], "1700000000"); // UNIX秒（文字列）
    assert.strictEqual(cap.headers?.["content-type"], "application/json");
    // ボディは { query, variables, operationName }。
    const sent = JSON.parse(cap.body || "{}");
    assert.strictEqual(sent.query, "query{ x }");
    assert.deepStrictEqual(sent.variables, { a: 1 });
    assert.strictEqual(sent.operationName, null);
  });

  it("GraphQL errors[] は投げずにそのまま返す（スキーマ調整のため）", async () => {
    withMakeshopEnv();
    const cap = {};
    const fetchFn = fakeFetch({ errors: [{ message: "Field 'foo' is not defined by type CreateCouponRequest" }] }, cap);
    const resp = await makeshopGraphql("mutation{ y }", {}, { fetchFn });
    assert.ok(resp.errors);
    assert.match(resp.errors![0].message, /not defined by type/);
  });

  it("HTTP 404（非JSON本文）は ok:false・diagnostics に URL/メソッド/ヘッダーキー/ステータス/本文を載せる", async () => {
    withMakeshopEnv();
    const fetchFn = async () => ({ ok: false, status: 404, async text() { return "<html>Not Found</html>"; } });
    const resp = await makeshopGraphql("q", {}, { fetchFn });
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.diagnostics.url, "https://api.example.test/graphql");
    assert.strictEqual(resp.diagnostics.method, "POST");
    assert.strictEqual(resp.diagnostics.httpStatus, 404);
    for (const k of ["authorization", "x-api-key", "x-timestamp", "content-type"]) {
      assert.ok(resp.diagnostics.headerKeys.includes(k), `header ${k} を送っている`);
    }
    assert.match(resp.diagnostics.bodyText, /Not Found/);
  });

  it("エンドポイント未設定（env未反映）は ok:false・診断でそれと分かる", async () => {
    process.env.MAKESHOP_API_ENDPOINT = "";
    process.env.MAKESHOP_ACCESS_TOKEN = "t";
    process.env.MAKESHOP_API_KEY = "k";
    const resp = await makeshopGraphql("q", {}, { fetchFn: async () => ({ ok: true, status: 200, async text() { return "{}"; } }) });
    assert.strictEqual(resp.ok, false);
    assert.match(resp.diagnostics.bodyText, /MAKESHOP_API_ENDPOINT/);
  });
});

describe("reissueName（再発行時の【再発行 M/D】付与）", () => {
  // 2027-07-24 12:00 JST = 2027-07-24 03:00 UTC
  const JUL24 = Date.UTC(2027, 6, 24, 3, 0, 0);
  it("元の名前に【再発行 M/D】(JST)を付ける", () => {
    assert.strictEqual(reissueName("株主優待10%OFF", JUL24), "株主優待10%OFF【再発行 7/24】");
  });
  it("既に【再発行 …】が付いていれば二重にせず日付を更新する", () => {
    assert.strictEqual(reissueName("株主優待10%OFF【再発行 3/1】", JUL24), "株主優待10%OFF【再発行 7/24】");
    assert.strictEqual(reissueName("株主優待10%OFF 【再発行 3/1】", JUL24), "株主優待10%OFF【再発行 7/24】");
  });
  it("JST 変換で日付がずれない（UTC深夜でも翌日にならない）", () => {
    // 2027-07-24 20:00 UTC = 2027-07-25 05:00 JST → 7/25
    assert.strictEqual(reissueName("X", Date.UTC(2027, 6, 24, 20, 0, 0)), "X【再発行 7/25】");
  });
});

describe("generateCouponCode", () => {
  it("許可文字（COUPON.CODE.ALPHABET）だけで規定長のコードを作る", () => {
    const re = new RegExp(`^[${COUPON.CODE.ALPHABET}]{${COUPON.CODE.LENGTH}}$`);
    for (let i = 0; i < 50; i++) assert.match(generateCouponCode(), re);
  });
  it("繰り返し生成しても衝突しにくい（重複が無い）", () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i++) set.add(generateCouponCode());
    assert.strictEqual(set.size, 200);
  });
});

describe("createCouponRaw（成否判定）", () => {
  const base = { code: "abc123", name: "株主優待10%OFF", discount: { discountType: "rate", discountValue: 10 }, startedAt: "2026-07-27 12:00:00", endedAt: "2027-03-31 23:59:59" };

  it("送信ボディが実スキーマ形（coupons配列・boolゲート・DiscountType enum・期間）になっている", async () => {
    withMakeshopEnv();
    const cap: { body?: string } = {};
    const fetchFn = fakeFetch({ data: { createCoupon: { results: [{ status: "SUCCESS", code: "abc123" }] } } }, cap);
    await createCouponRaw(base, { fetchFn });
    const sent = JSON.parse(cap.body || "{}");
    const c = sent.variables.input.coupons[0];
    assert.ok(Array.isArray(sent.variables.input.coupons), "coupons は配列");
    assert.strictEqual(c.code, "abc123");
    assert.strictEqual(c.name, "株主優待10%OFF");
    assert.strictEqual(c.isEnabled, true);
    assert.strictEqual(c.isForOnlyMember, true);
    assert.strictEqual(c.hasMaximumMemberUsableCount, true);
    assert.strictEqual(c.maximumMemberUsableCount, 1);
    assert.strictEqual(c.hasTotalUseCount, true);
    assert.strictEqual(c.totalUseCount, 1);
    assert.strictEqual(c.isTargetProduct, false);
    assert.strictEqual(c.discountType, "FIXED_RATE");
    assert.strictEqual(c.fixedRate, 10);
    assert.strictEqual(c.hasPeriod, true);
    assert.strictEqual(c.startedAt, "2026-07-27 12:00:00");
    assert.strictEqual(c.endedAt, "2027-03-31 23:59:59");
    assert.strictEqual(c.useCountType, undefined, "useCountType は送らない");
  });

  it("定額割引は discountType=FIXED_AMOUNT / fixedAmount を送る", async () => {
    withMakeshopEnv();
    const cap: { body?: string } = {};
    const fetchFn = fakeFetch({ data: { createCoupon: { results: [{ status: "SUCCESS", code: "x" }] } } }, cap);
    await createCouponRaw({ ...base, discount: { discountType: "amount", discountValue: 500 } }, { fetchFn });
    const c = JSON.parse(cap.body || "{}").variables.input.coupons[0];
    assert.strictEqual(c.discountType, "FIXED_AMOUNT");
    assert.strictEqual(c.fixedAmount, 500);
    assert.strictEqual(c.fixedRate, undefined);
  });

  it("results 配列の先頭から status OK・code を取り出す（実スキーマ形）", async () => {
    withMakeshopEnv();
    const cap = {};
    const fetchFn = fakeFetch({ data: { createCoupon: { results: [{ status: "SUCCESS", code: "abc123", name: "x", errorMessage: null }] } } }, cap);
    const r = await createCouponRaw(base, { fetchFn });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.code, "abc123");
  });

  it("results 先頭が NG なら ok:false・errorMessage を拾う（実スキーマ形）", async () => {
    withMakeshopEnv();
    const cap = {};
    const fetchFn = fakeFetch({ data: { createCoupon: { results: [{ status: "NG", errorMessage: "コードが重複しています" }] } } }, cap);
    const r = await createCouponRaw(base, { fetchFn });
    assert.strictEqual(r.ok, false);
    assert.match(r.errorMessage || "", /重複/);
  });

  it("旧形（直下 status/code）も後方互換で拾える", async () => {
    withMakeshopEnv();
    const cap = {};
    const fetchFn = fakeFetch({ data: { createCoupon: { status: "SUCCESS", code: "abc123", name: "x" } } }, cap);
    const r = await createCouponRaw(base, { fetchFn });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.code, "abc123");
  });

  it("GraphQL errors[] は errorMessage に集約し raw も返す", async () => {
    withMakeshopEnv();
    const cap = {};
    const fetchFn = fakeFetch({ errors: [{ message: "Unknown argument \"input\"" }] }, cap);
    const r = await createCouponRaw(base, { fetchFn });
    assert.strictEqual(r.ok, false);
    assert.match(r.errorMessage || "", /Unknown argument/);
    assert.ok(r.raw);
  });

  it("HTTP 404 は ok:false・errorMessage に URL/ステータス、raw.diagnostics を含む", async () => {
    withMakeshopEnv();
    const fetchFn = async () => ({ ok: false, status: 404, async text() { return "Not Found"; } });
    const r = await createCouponRaw(base, { fetchFn });
    assert.strictEqual(r.ok, false);
    assert.match(r.errorMessage || "", /404/);
    assert.match(r.errorMessage || "", /api\.example\.test/);
    assert.ok((r.raw as { diagnostics?: unknown }).diagnostics);
  });
});

describe("createCouponWithRetry（重複だけ再生成・他は即返す）", () => {
  const base = { name: "株主優待", discount: { discountType: "rate", discountValue: 10 }, startedAt: "2026-07-27 12:00:00", endedAt: "2027-03-31 23:59:59" };

  it("重複NGは新コードでリトライし、成功したら ok:true", async () => {
    withMakeshopEnv();
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      const json = calls < 3
        ? { data: { createCoupon: { status: "NG", errorMessage: "コードが重複しています" } } }
        : { data: { createCoupon: { status: "SUCCESS", code: "final" } } };
      return { ok: true, status: 200, async text() { return JSON.stringify(json); } };
    };
    const r = await createCouponWithRetry(base, { fetchFn });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls, 3); // 2回重複→3回目成功
  });

  it("重複以外のエラーは1回で即返す（リトライしない）", async () => {
    withMakeshopEnv();
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      const json = { errors: [{ message: "Field 'useCountType' is not defined" }] };
      return { ok: true, status: 200, async text() { return JSON.stringify(json); } };
    };
    const r = await createCouponWithRetry(base, { fetchFn });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(calls, 1); // 即返す
    assert.match(r.errorMessage || "", /not defined/);
  });
});

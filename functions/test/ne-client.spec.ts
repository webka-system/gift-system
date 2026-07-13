/**
 * ne/client の単体テスト（トークンローテーションの要）。
 * fetch とトークンストアを注入し、Firestore/NE 無しで挙動を固定する。
 */

import * as assert from "node:assert";
import { neApiCall, neAuthExchange, neApiUpload, percentEncodeBytes, NeApiError } from "../src/ne/client";
import { NeTokens, NeTokenStore } from "../src/ne/tokens";

function memStore(init: NeTokens): NeTokenStore & { current: NeTokens } {
  const s = {
    current: { ...init },
    async load() { return { ...s.current }; },
    async save(t: NeTokens) { s.current = { ...t }; },
  };
  return s;
}

// 指定のJSONを返す fake fetch。送信ボディを captured に記録する。
function fakeFetch(responseJson: unknown, captured: { body?: string }) {
  return async (_url: string, init: { body: string }) => {
    captured.body = init.body;
    return {
      ok: true,
      status: 200,
      async json() { return responseJson; },
      async text() { return JSON.stringify(responseJson); },
    };
  };
}

describe("neApiCall", () => {
  it("既存トークンを送信し、返却された新トークンを保存する（ローテーション）", async () => {
    const store = memStore({ accessToken: "old-a", refreshToken: "old-r" });
    const cap: { body?: string } = {};
    const fetchFn = fakeFetch({ result: "success", access_token: "new-a", refresh_token: "new-r", data: 1 }, cap);

    const data = await neApiCall("/api_v1_test", { foo: "bar" }, { fetchFn, store });

    // 送信ボディに「古い」トークンとパラメータが載る。
    const sent = new URLSearchParams(cap.body);
    assert.strictEqual(sent.get("access_token"), "old-a");
    assert.strictEqual(sent.get("refresh_token"), "old-r");
    assert.strictEqual(sent.get("foo"), "bar");
    // 返却された「新しい」トークンが保存される。
    assert.strictEqual(store.current.accessToken, "new-a");
    assert.strictEqual(store.current.refreshToken, "new-r");
    assert.strictEqual((data as { data: number }).data, 1);
  });

  it("result!==success は NeApiError を投げる（ただし返却トークンは保存する）", async () => {
    const store = memStore({ accessToken: "old-a", refreshToken: "old-r" });
    const cap: { body?: string } = {};
    const fetchFn = fakeFetch({ result: "error", code: "003007", message: "invalid", refresh_token: "rot-r" }, cap);

    await assert.rejects(
      () => neApiCall("/api_v1_test", {}, { fetchFn, store }),
      (err: unknown) => err instanceof NeApiError && (err as NeApiError).code === "003007",
    );
    // エラーでもローテーションされたトークンは保存される。
    assert.strictEqual(store.current.refreshToken, "rot-r");
  });

  it("新トークンが返らなければ既存トークンを維持する", async () => {
    const store = memStore({ accessToken: "keep-a", refreshToken: "keep-r" });
    const cap: { body?: string } = {};
    const fetchFn = fakeFetch({ result: "success" }, cap);

    await neApiCall("/api_v1_test", {}, { fetchFn, store });
    assert.strictEqual(store.current.accessToken, "keep-a");
    assert.strictEqual(store.current.refreshToken, "keep-r");
  });

  it("通常のv1 API呼び出しでは client_id / client_secret を送らない（認証交換専用）", async () => {
    const store = memStore({ accessToken: "a", refreshToken: "r" });
    const cap: { body?: string } = {};
    const fetchFn = fakeFetch({ result: "success" }, cap);

    await neApiCall("/api_v1_test", { foo: "bar" }, { fetchFn, store });
    const sent = new URLSearchParams(cap.body);
    assert.strictEqual(sent.has("client_id"), false);
    assert.strictEqual(sent.has("client_secret"), false);
  });
});

describe("neAuthExchange", () => {
  it("uid/state/client_id/client_secret を送り、返却トークンを保存する", async () => {
    const prevId = process.env.NE_CLIENT_ID;
    const prevSecret = process.env.NE_CLIENT_SECRET;
    process.env.NE_CLIENT_ID = "cid";
    process.env.NE_CLIENT_SECRET = "csecret";
    try {
      const store = memStore({ accessToken: "", refreshToken: "" });
      const cap: { body?: string } = {};
      const fetchFn = fakeFetch(
        { result: "success", access_token: "init-a", refresh_token: "init-r", company_ne_id: "42" },
        cap,
      );

      const data = await neAuthExchange("UID1", "STATE1", { fetchFn, store });

      const sent = new URLSearchParams(cap.body);
      assert.strictEqual(sent.get("uid"), "UID1");
      assert.strictEqual(sent.get("state"), "STATE1");
      assert.strictEqual(sent.get("client_id"), "cid");
      assert.strictEqual(sent.get("client_secret"), "csecret");
      // 交換で得た初期トークンが保存される。
      assert.strictEqual(store.current.accessToken, "init-a");
      assert.strictEqual(store.current.refreshToken, "init-r");
      assert.strictEqual((data as { company_ne_id: string }).company_ne_id, "42");
    } finally {
      process.env.NE_CLIENT_ID = prevId;
      process.env.NE_CLIENT_SECRET = prevSecret;
    }
  });
});

describe("percentEncodeBytes", () => {
  it("各バイトを %XX（大文字）で符号化する（Shift-JIS を壊さない）", () => {
    // 「あ」= Shift-JIS 0x82 0xA0。
    assert.strictEqual(percentEncodeBytes(Buffer.from([0x82, 0xa0])), "%82%A0");
    // ASCII も含め全バイトを %XX にする。
    assert.strictEqual(percentEncodeBytes(Buffer.from("A,", "latin1")), "%41%2C");
  });
});

describe("neApiUpload", () => {
  it("通常パラメータ＋access/refresh を form 化し、末尾にバイト列を percent-encode で載せる", async () => {
    const store = memStore({ accessToken: "a", refreshToken: "r" });
    const cap: { body?: string } = {};
    const fetchFn = fakeFetch({ result: "success", que_id: "45", access_token: "a2" }, cap);

    const bytes = Buffer.from([0x82, 0xa0]); // Shift-JIS「あ」
    const data = await neApiUpload(
      "/api_v1_receiveorder_base/upload",
      { receive_order_upload_pattern_id: "11", data_type_1: "csv" },
      "data_1",
      bytes,
      { fetchFn, store },
    );

    const body = cap.body || "";
    assert.ok(body.includes("access_token=a"));
    assert.ok(body.includes("receive_order_upload_pattern_id=11"));
    assert.ok(body.includes("data_type_1=csv"));
    // data_1 は URLSearchParams ではなく手動連結で %82%A0 が載る。
    assert.ok(body.includes("data_1=%82%A0"), `body should carry SJIS bytes: ${body}`);
    // client_id/secret は載らない。
    assert.strictEqual(new URLSearchParams(body).has("client_id"), false);
    // ローテーション保存。
    assert.strictEqual(store.current.accessToken, "a2");
    assert.strictEqual((data as { que_id: string }).que_id, "45");
  });
});

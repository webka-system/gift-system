/**
 * ne/client の単体テスト（トークンローテーションの要）。
 * fetch とトークンストアを注入し、Firestore/NE 無しで挙動を固定する。
 */

import * as assert from "node:assert";
import { neApiCall, NeApiError } from "../src/ne/client";
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
});

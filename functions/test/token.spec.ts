/**
 * lib/token の単体テスト。
 * 受け取り者トークンは外部アクセス制御の要（design.md 第8章）のため、
 * 「URL-safe」「十分な長さ」「衝突しない」ことを最低限担保する。
 */

import * as assert from "node:assert";
import { generateCardToken } from "../src/lib/token";
import { TOKEN } from "../src/config/constants";

describe("generateCardToken", () => {
  it("URL-safe な文字集合（base64url）のみで構成される", () => {
    const t = generateCardToken();
    assert.match(t, /^[A-Za-z0-9_-]+$/);
  });

  it("TOKEN.BYTES 相当の十分な長さがある（base64url は約1.33倍）", () => {
    const t = generateCardToken();
    // base64url の文字数 ≒ ceil(bytes*4/3)。総当り困難な長さを担保。
    assert.ok(t.length >= TOKEN.BYTES, `token too short: ${t.length}`);
  });

  it("繰り返し生成しても衝突しない（推測不可能・一意）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      const t = generateCardToken();
      assert.ok(!seen.has(t), "duplicate token generated");
      seen.add(t);
    }
  });
});

/**
 * http/guard requireAuth の単体テスト（最重要）。
 *
 * invoker:"public" により Cloud Run の入口ガードが無くなるため、admin系関数の防御は requireAuth のみ。
 * 「未認証・不正トークンは必ず 401 で拒否」「正規トークンのみ通す」ことを保証する。
 */

import * as assert from "node:assert";
import { requireAuth, AuthDeps } from "../src/http/guard";

// status(n).json(b) を捕捉する最小の res モック。
function mockRes() {
  const out: { status: number | null; body: unknown } = { status: null, body: null };
  const res = {
    status(n: number) { out.status = n; return { json(b: unknown) { out.body = b; return out; } }; },
    _out: out,
  };
  return res;
}

// 常に成功する verifyToken（正規トークン相当）。
const okDeps: AuthDeps = { async verifyToken() { return { uid: "u1", email: "a@ex.com" }; } };
// 常に失敗する verifyToken（不正・期限切れトークン相当）。
const badDeps: AuthDeps = { async verifyToken() { throw Object.assign(new Error("boom"), { code: "auth/argument-error" }); } };

describe("requireAuth", () => {
  it("Authorization ヘッダ無し → 401・null（未認証拒否）", async () => {
    const res = mockRes();
    const r = await requireAuth({ headers: {} }, res, okDeps);
    assert.strictEqual(r, null);
    assert.strictEqual(res._out.status, 401);
    assert.deepStrictEqual(res._out.body, { ok: false, code: "unauthenticated" });
  });

  it("Bearer でない Authorization → 401・null", async () => {
    const res = mockRes();
    const r = await requireAuth({ headers: { authorization: "Basic abc" } }, res, okDeps);
    assert.strictEqual(r, null);
    assert.strictEqual(res._out.status, 401);
  });

  it("トークンはあるが検証失敗（不正/期限切れ） → 401・null", async () => {
    const res = mockRes();
    const r = await requireAuth({ headers: { authorization: "Bearer eyJbad" } }, res, badDeps);
    assert.strictEqual(r, null);
    assert.strictEqual(res._out.status, 401);
    assert.deepStrictEqual(res._out.body, { ok: false, code: "unauthenticated" });
  });

  it('文字列 "Bearer null"（トークン欠落フロントの誤送信）も検証失敗で 401', async () => {
    const res = mockRes();
    const r = await requireAuth({ headers: { authorization: "Bearer null" } }, res, badDeps);
    assert.strictEqual(r, null);
    assert.strictEqual(res._out.status, 401);
  });

  it("正規トークン → 素性を返し、res には何も書かない（通過）", async () => {
    const res = mockRes();
    const r = await requireAuth({ headers: { authorization: "Bearer valid.jwt.here" } }, res, okDeps);
    assert.deepStrictEqual(r, { uid: "u1", email: "a@ex.com" });
    assert.strictEqual(res._out.status, null); // 401等を書いていない
  });

  it("Authorization ヘッダ名の大文字小文字を問わない", async () => {
    const res = mockRes();
    const r = await requireAuth({ headers: { Authorization: "Bearer valid.jwt.here" } }, res, okDeps);
    assert.deepStrictEqual(r, { uid: "u1", email: "a@ex.com" });
  });
});

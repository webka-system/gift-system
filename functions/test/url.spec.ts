/**
 * lib/url（受け取り者URLの組み立て）の単体テスト。
 * kind で接頭辞が切り替わること（catalog=/g/ / coupon=/gc/）を固定＝印刷QRの着地先が正しいこと。
 */

import * as assert from "node:assert";
import { buildCardUrl } from "../src/lib/url";

const ORIGIN = "https://gift-system-f33b5.web.app";

describe("buildCardUrl（kind で接頭辞を切り替える）", () => {
  it("catalog（既定・未指定）は /g/ を使う（後方互換）", () => {
    assert.strictEqual(buildCardUrl(ORIGIN, "TOK"), `${ORIGIN}/g/TOK`);
    assert.strictEqual(buildCardUrl(ORIGIN, "TOK", "catalog"), `${ORIGIN}/g/TOK`);
  });
  it("coupon は /gc/ を使う（クーポン専用ページへ）", () => {
    assert.strictEqual(buildCardUrl(ORIGIN, "TOK", "coupon"), `${ORIGIN}/gc/TOK`);
  });
  it("token は URL エンコードされる", () => {
    assert.strictEqual(buildCardUrl(ORIGIN, "a b/c", "coupon"), `${ORIGIN}/gc/a%20b%2Fc`);
  });
});

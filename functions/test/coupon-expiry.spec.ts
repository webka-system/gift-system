/**
 * adminGenerateGiftCards のクーポン有効期限パース（parseExpiryDateJst）の単体テスト。
 * kind=coupon 生成時に「YYYY-MM-DD」を JST のその日の終わり(23:59:59)の Timestamp に変換する。
 * QR受け取りゲートと MakeShop createCoupon.endedAt の両方に使う、単回発行の期限の起点。
 */

import * as assert from "node:assert";
import { parseExpiryDateJst } from "../src/http/admin-qr";

describe("parseExpiryDateJst（クーポン有効期限・ロット単位の絶対日付）", () => {
  it("有効な日付を JST 23:59:59.999 の Timestamp にする（=同日14:59:59.999 UTC）", () => {
    const ts = parseExpiryDateJst("2027-03-31");
    assert.ok(ts, "Timestamp が返ること");
    const expected = Date.UTC(2027, 2, 31, 23, 59, 59, 999) - 9 * 60 * 60 * 1000;
    assert.strictEqual(ts!.toMillis(), expected);
    // JST に直すと 2027-03-31 23:59 であること（日付が前日/翌日にずれない）。
    const jst = new Date(ts!.toMillis() + 9 * 60 * 60 * 1000);
    assert.strictEqual(jst.getUTCFullYear(), 2027);
    assert.strictEqual(jst.getUTCMonth(), 2); // 3月
    assert.strictEqual(jst.getUTCDate(), 31);
    assert.strictEqual(jst.getUTCHours(), 23);
  });

  it("フォーマット不正は null（YYYY-MM-DD 以外）", () => {
    assert.strictEqual(parseExpiryDateJst(""), null);
    assert.strictEqual(parseExpiryDateJst("2027/03/31"), null);
    assert.strictEqual(parseExpiryDateJst("2027-3-31"), null);
    assert.strictEqual(parseExpiryDateJst("2027-03-31T00:00"), null);
    assert.strictEqual(parseExpiryDateJst("abc"), null);
  });

  it("実在しない日付は null（桁は合うが不正な日）", () => {
    assert.strictEqual(parseExpiryDateJst("2027-02-30"), null); // 2月30日は無い
    assert.strictEqual(parseExpiryDateJst("2027-13-01"), null); // 13月は無い
    assert.strictEqual(parseExpiryDateJst("2027-00-10"), null); // 0月は無い
  });

  it("うるう年は 2-29 を許容し、平年は弾く", () => {
    assert.ok(parseExpiryDateJst("2028-02-29"), "2028はうるう年");
    assert.strictEqual(parseExpiryDateJst("2027-02-29"), null); // 2027は平年
  });
});

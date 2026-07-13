/**
 * shared/delivery.js（配達希望日の範囲判定）の単体テスト。
 * iOS Safari で <input type="date"> の min/max が効かない問題のクライアント保険ロジック。
 * サーバ検証は別（order-fields）＝最終防衛線。ここはクライアントと共有する純粋ロジックの検証。
 */

import * as assert from "node:assert";
import { deliveryDateBounds, isDeliveryDateInRange, ymdToJp } from "../src/config/delivery";

const MIN_DAYS = 14;
const MAX_MONTHS = 2;
// 基準日を固定（ローカルタイムに依存しないよう「正午」を使い、TZずれで日付が跨がないようにする）。
const NOW = new Date(2026, 6, 13, 12, 0, 0).getTime(); // 2026-07-13 12:00 ローカル

describe("deliveryDateBounds", () => {
  it("min=+14日 / max=+2か月 を YYYY-MM-DD で返す", () => {
    const { min, max } = deliveryDateBounds(NOW, MIN_DAYS, MAX_MONTHS);
    assert.strictEqual(min, "2026-07-27"); // 7/13 + 14日
    assert.strictEqual(max, "2026-09-13"); // 7/13 + 2か月
  });
});

describe("isDeliveryDateInRange", () => {
  it("未入力（空）は true（任意・範囲チェック対象外）", () => {
    assert.strictEqual(isDeliveryDateInRange("", NOW, MIN_DAYS, MAX_MONTHS), true);
  });
  it("範囲内（+20日）は true", () => {
    assert.strictEqual(isDeliveryDateInRange("2026-08-02", NOW, MIN_DAYS, MAX_MONTHS), true);
  });
  it("最小境界（ちょうど+14日）は true", () => {
    assert.strictEqual(isDeliveryDateInRange("2026-07-27", NOW, MIN_DAYS, MAX_MONTHS), true);
  });
  it("最大境界（ちょうど+2か月）は true", () => {
    assert.strictEqual(isDeliveryDateInRange("2026-09-13", NOW, MIN_DAYS, MAX_MONTHS), true);
  });
  it("早すぎる（+13日＝最小の前日）は false", () => {
    assert.strictEqual(isDeliveryDateInRange("2026-07-26", NOW, MIN_DAYS, MAX_MONTHS), false);
  });
  it("翌日など直近（+1日）は false", () => {
    assert.strictEqual(isDeliveryDateInRange("2026-07-14", NOW, MIN_DAYS, MAX_MONTHS), false);
  });
  it("遠すぎる（+2か月の翌日）は false", () => {
    assert.strictEqual(isDeliveryDateInRange("2026-09-14", NOW, MIN_DAYS, MAX_MONTHS), false);
  });
  it("はるか未来（iOS Safari で無限に選べてしまうケース）は false", () => {
    assert.strictEqual(isDeliveryDateInRange("2027-12-31", NOW, MIN_DAYS, MAX_MONTHS), false);
  });
});

describe("ymdToJp", () => {
  it("YYYY-MM-DD → M月D日（ゼロ埋めなし）", () => {
    assert.strictEqual(ymdToJp("2026-07-27"), "7月27日");
    assert.strictEqual(ymdToJp("2026-09-13"), "9月13日");
    assert.strictEqual(ymdToJp("2026-01-05"), "1月5日");
  });
});

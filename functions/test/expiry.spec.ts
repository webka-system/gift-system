/**
 * shared/expiry.js（有効期限判定）の単体テスト。受け取り者確定・管理画面で共有するロジック。
 */

import * as assert from "node:assert";
import { resolveExpiryDays, expiryMillis, expiryInfo, EXPIRY_NEAR_DAYS } from "../src/config/expiry";

const DAY = 24 * 60 * 60 * 1000;
const GEN = Date.UTC(2026, 0, 1); // 生成日: 2026-01-01

describe("resolveExpiryDays（個別上書き > 種別デフォルト）", () => {
  it("上書きが正の整数なら上書きを優先", () => {
    assert.strictEqual(resolveExpiryDays(10, 30), 10);
  });
  it("上書きが無ければ種別デフォルト", () => {
    assert.strictEqual(resolveExpiryDays(undefined, 30), 30);
  });
  it("両方無ければ null（無期限）", () => {
    assert.strictEqual(resolveExpiryDays(undefined, undefined), null);
  });
  it("0・負・非整数は無効（種別にフォールバック）", () => {
    assert.strictEqual(resolveExpiryDays(0, 30), 30);
    assert.strictEqual(resolveExpiryDays(-5, 30), 30);
    assert.strictEqual(resolveExpiryDays(1.5, 30), 30);
  });
  it("両方無効なら null", () => {
    assert.strictEqual(resolveExpiryDays(0, 0), null);
  });
});

describe("expiryMillis", () => {
  it("generatedAt + 日数", () => {
    assert.strictEqual(expiryMillis(GEN, 30), GEN + 30 * DAY);
  });
  it("generatedAt 不明は null（無期限）", () => {
    assert.strictEqual(expiryMillis(undefined as unknown as number, 30), null);
  });
  it("日数 null は null（無期限）", () => {
    assert.strictEqual(expiryMillis(GEN, null as unknown as number), null);
  });
});

describe("expiryInfo", () => {
  it("有効日数未設定は無期限（期限切れにしない）", () => {
    const r = expiryInfo({ generatedAtMs: GEN, typeDays: undefined, nowMs: GEN + 1000 * DAY });
    assert.strictEqual(r.hasExpiry, false);
    assert.strictEqual(r.expired, false);
  });
  it("generatedAt 不明は無期限（既存カードの後方互換）", () => {
    const r = expiryInfo({ generatedAtMs: undefined, typeDays: 30, nowMs: GEN + 1000 * DAY });
    assert.strictEqual(r.hasExpiry, false);
    assert.strictEqual(r.expired, false);
  });
  it("期限内は expired=false・残り日数を返す", () => {
    const r = expiryInfo({ generatedAtMs: GEN, typeDays: 30, nowMs: GEN + 10 * DAY });
    assert.strictEqual(r.expired, false);
    assert.strictEqual(r.remainingDays, 20);
    assert.strictEqual(r.near, false);
  });
  it(`残り ${EXPIRY_NEAR_DAYS} 日以内は near=true`, () => {
    const r = expiryInfo({ generatedAtMs: GEN, typeDays: 30, nowMs: GEN + 25 * DAY });
    assert.strictEqual(r.expired, false);
    assert.strictEqual(r.remainingDays, 5);
    assert.strictEqual(r.near, true);
  });
  it("期限超過は expired=true", () => {
    const r = expiryInfo({ generatedAtMs: GEN, typeDays: 30, nowMs: GEN + 31 * DAY });
    assert.strictEqual(r.expired, true);
    assert.strictEqual(r.near, false);
  });
  it("個別上書きが種別より優先（短縮で期限切れに）", () => {
    const r = expiryInfo({ generatedAtMs: GEN, overrideDays: 5, typeDays: 30, nowMs: GEN + 10 * DAY });
    assert.strictEqual(r.expired, true);
  });
  it("個別上書きで延長すると期限切れが解消（管理者の救済）", () => {
    const now = GEN + 40 * DAY;
    const before = expiryInfo({ generatedAtMs: GEN, typeDays: 30, nowMs: now });
    assert.strictEqual(before.expired, true);
    const after = expiryInfo({ generatedAtMs: GEN, overrideDays: 60, typeDays: 30, nowMs: now });
    assert.strictEqual(after.expired, false);
    assert.strictEqual(after.remainingDays, 20);
  });
});

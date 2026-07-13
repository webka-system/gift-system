/**
 * config/env の投入ゲーティング（isNeAutoConfigured / isNeSubmitEnabled）の単体テスト。
 * NE_MODE と NE_UPLOAD_PATTERN_ID の組み合わせで、自動トリガーと手動投入の可否が分かれることを固定する。
 */

import * as assert from "node:assert";
import { isNeAutoConfigured, isNeSubmitEnabled } from "../src/config/env";

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const keys = ["NE_MODE", "NE_UPLOAD_PATTERN_ID", "NE_UPLOAD_ENDPOINT"];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe("NE 投入ゲーティング", () => {
  it("csv: どちらも無効（自動トリガーも手動投入もオフ）", () => {
    withEnv({ NE_MODE: "csv", NE_UPLOAD_PATTERN_ID: "11" }, () => {
      assert.strictEqual(isNeAutoConfigured(), false);
      assert.strictEqual(isNeSubmitEnabled(), false);
    });
  });

  it("manual: 自動トリガーは無効・手動投入は有効", () => {
    withEnv({ NE_MODE: "manual", NE_UPLOAD_PATTERN_ID: "11" }, () => {
      assert.strictEqual(isNeAutoConfigured(), false);
      assert.strictEqual(isNeSubmitEnabled(), true);
    });
  });

  it("auto: 自動トリガーも手動投入も有効", () => {
    withEnv({ NE_MODE: "auto", NE_UPLOAD_PATTERN_ID: "11" }, () => {
      assert.strictEqual(isNeAutoConfigured(), true);
      assert.strictEqual(isNeSubmitEnabled(), true);
    });
  });

  it("パターンID未設定なら auto でも両方無効（別店舗誤登録防止）", () => {
    withEnv({ NE_MODE: "auto", NE_UPLOAD_PATTERN_ID: "" }, () => {
      assert.strictEqual(isNeAutoConfigured(), false);
      assert.strictEqual(isNeSubmitEnabled(), false);
    });
  });
});

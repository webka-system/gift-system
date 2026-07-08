/**
 * NE API トランスポート（トークンローテーション込みの低レベル呼び出し）
 *
 * NE API の作法:
 *   - POST（application/x-www-form-urlencoded）で client_id / client_secret / access_token /
 *     refresh_token ＋ 各APIのパラメータを送る。
 *   - レスポンス JSON に result（"success" / "error"）と、更新後の access_token / refresh_token が
 *     含まれることがある。**返ってきたトークンは必ず保存**して次回に使う。
 *
 * この層は「項目マッピング」を持たない（それは ne/order.ts の責務）。ここは通信とトークン管理のみ。
 * fetch とトークンストアを注入可能にして単体テストできるようにしてある。
 */

import { neConfig } from "../config/env";
import { firestoreTokenStore, NeTokenStore } from "./tokens";

export class NeApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "NeApiError";
  }
}

type FetchFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface NeCallDeps {
  fetchFn?: FetchFn;
  store?: NeTokenStore;
}

interface NeResponse {
  result?: string;
  code?: string;
  message?: string;
  access_token?: string;
  refresh_token?: string;
  [k: string]: unknown;
}

/**
 * NE API を1回呼ぶ。成功時はレスポンス JSON を返す。
 *   - 返却された access_token / refresh_token があればストアへ保存（ローテーション）。
 *   - result!=="success" は NeApiError（code/message）を投げる。
 */
export async function neApiCall(
  pathname: string,
  params: Record<string, string | number>,
  deps: NeCallDeps = {},
): Promise<NeResponse> {
  const cfg = neConfig();
  const fetchFn = (deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn));
  const store = deps.store ?? firestoreTokenStore;

  const tokens = await store.load();
  const form = new URLSearchParams();
  form.set("client_id", cfg.clientId);
  form.set("client_secret", cfg.clientSecret);
  if (tokens.accessToken) form.set("access_token", tokens.accessToken);
  if (tokens.refreshToken) form.set("refresh_token", tokens.refreshToken);
  for (const [k, v] of Object.entries(params)) form.set(k, String(v));

  const res = await fetchFn(cfg.apiBase + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const data = (await res.json()) as NeResponse;

  // 更新後トークンが返っていれば保存（NE 流のローテーション）。
  if (data && (data.access_token || data.refresh_token)) {
    await store.save({
      accessToken: data.access_token || tokens.accessToken,
      refreshToken: data.refresh_token || tokens.refreshToken,
    });
  }

  if (data?.result !== "success") {
    throw new NeApiError(data?.code || `http_${res.status}`, data?.message || "NE API call failed");
  }
  return data;
}

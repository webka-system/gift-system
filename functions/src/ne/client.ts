/**
 * NE API トランスポート（トークンローテーション込みの低レベル呼び出し）
 *
 * NE API の作法（公式リファレンスで確定）:
 *   - POST（application/x-www-form-urlencoded）で各APIのパラメータを送る。
 *   - **通常の v1 API**（アップロード / キュー検索 / パターン情報 等）は **access_token + refresh_token** のみで動く。
 *     client_id / client_secret は付けない（認証交換専用）。
 *   - **認証交換 /api_neauth** だけは uid + state + client_id + client_secret を送り、初回の
 *     access_token / refresh_token を得る（→ neAuthExchange）。
 *   - どのAPIでもレスポンス JSON に result（"success" / "error"）と、更新後の access_token / refresh_token が
 *     含まれることがある。**返ってきたトークンは必ず保存**して次回に使う（NE最重要のクセ）。
 *     access_token は有効期限1日 / refresh_token は3日。更新されると古い値は無効になる。
 *
 * この層は「項目マッピング」を持たない（それは ne/order.ts・ne/csv.ts の責務）。ここは通信とトークン管理のみ。
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

export interface NeResponse {
  result?: string;
  code?: string;
  message?: string;
  access_token?: string;
  refresh_token?: string;
  [k: string]: unknown;
}

/** 返却トークンがあればストアへ保存（ローテーション）。無ければ既存を維持。エラー時も呼ぶ。 */
async function persistRotatedTokens(
  store: NeTokenStore,
  prev: { accessToken: string; refreshToken: string },
  data: NeResponse | undefined,
): Promise<void> {
  if (data && (data.access_token || data.refresh_token)) {
    await store.save({
      accessToken: data.access_token || prev.accessToken,
      refreshToken: data.refresh_token || prev.refreshToken,
    });
  }
}

/** 文字列ボディを x-www-form-urlencoded で POST し、JSON を返す（低レベル）。 */
async function postBody(
  pathname: string,
  body: string,
  fetchFn: FetchFn,
): Promise<{ data: NeResponse; status: number }> {
  const cfg = neConfig();
  const res = await fetchFn(cfg.apiBase + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as NeResponse;
  return { data, status: res.status };
}

/** access_token/refresh_token ＋ 通常パラメータの form-urlencoded 文字列を組み立てる（client_id/secret は付けない）。 */
function baseFormBody(
  tokens: { accessToken: string; refreshToken: string },
  params: Record<string, string | number>,
): string {
  const form = new URLSearchParams();
  if (tokens.accessToken) form.set("access_token", tokens.accessToken);
  if (tokens.refreshToken) form.set("refresh_token", tokens.refreshToken);
  for (const [k, v] of Object.entries(params)) form.set(k, String(v));
  return form.toString();
}

/**
 * バイト列を x-www-form-urlencoded 用に **1バイトずつ %XX** で percent-encode する。
 * ★Shift-JIS(CP932) の CSV を data_1 に載せるための要。URLSearchParams は JS 文字列を UTF-8 で
 *   再エンコードしてしまい Shift-JIS バイトが壊れるため、バイト列は必ずこの関数で符号化する。
 *   全バイトを %XX にするのは冗長だが、区切り(& =)や非ASCIIの取り違えが無く最も安全。
 */
export function percentEncodeBytes(buf: Buffer): string {
  let out = "";
  for (const b of buf) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  return out;
}

/**
 * 通常の NE v1 API を1回呼ぶ（access_token + refresh_token で認証）。成功時はレスポンス JSON を返す。
 *   - 送信: access_token / refresh_token ＋ 各APIのパラメータ（client_id/secret は送らない）。
 *   - 返却された access_token / refresh_token があればストアへ保存（ローテーション）。エラー時も保存する。
 *   - result!=="success" は NeApiError（code/message）を投げる。
 */
export async function neApiCall(
  pathname: string,
  params: Record<string, string | number>,
  deps: NeCallDeps = {},
): Promise<NeResponse> {
  const fetchFn = (deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn));
  const store = deps.store ?? firestoreTokenStore;

  const tokens = await store.load();
  const body = baseFormBody(tokens, params);

  const { data, status } = await postBody(pathname, body, fetchFn);

  await persistRotatedTokens(store, tokens, data);

  if (data?.result !== "success") {
    throw new NeApiError(data?.code || `http_${status}`, data?.message || "NE API call failed");
  }
  return data;
}

/**
 * 受注伝票アップロード等、**バイナリ(Shift-JIS CSV)を1フィールドに載せる** API を呼ぶ。
 *   - 通常パラメータ（receive_order_upload_pattern_id / data_type_1 / wait_flag 等）＋ access/refresh を form 化し、
 *     末尾に `<byteFieldName>=<percentEncodeBytes(bytes)>` を連結する（Shift-JIS を壊さないため）。
 *   - トークンローテーション保存・result 判定は neApiCall と同じ。
 */
export async function neApiUpload(
  pathname: string,
  params: Record<string, string | number>,
  byteFieldName: string,
  bytes: Buffer,
  deps: NeCallDeps = {},
): Promise<NeResponse> {
  const fetchFn = (deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn));
  const store = deps.store ?? firestoreTokenStore;

  const tokens = await store.load();
  let body = baseFormBody(tokens, params);
  body += (body ? "&" : "") + encodeURIComponent(byteFieldName) + "=" + percentEncodeBytes(bytes);

  const { data, status } = await postBody(pathname, body, fetchFn);

  await persistRotatedTokens(store, tokens, data);

  if (data?.result !== "success") {
    throw new NeApiError(data?.code || `http_${status}`, data?.message || "NE upload failed");
  }
  return data;
}

/**
 * 認証交換 /api_neauth を呼ぶ（初回トークン取得）。
 *   - 送信: uid / state / client_id / client_secret（アクセストークンはまだ無い）。
 *   - 成功時はレスポンスの access_token / refresh_token をストアへ保存し、レスポンス全体（アカウント情報含む）を返す。
 *   - result!=="success" は NeApiError を投げる。
 *
 * ★ client_id / client_secret は Secret Manager から neCallback にのみ注入される。neConfig() 経由で読む。
 */
export async function neAuthExchange(
  uid: string,
  state: string,
  deps: NeCallDeps = {},
): Promise<NeResponse> {
  const cfg = neConfig();
  const fetchFn = (deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn));
  const store = deps.store ?? firestoreTokenStore;

  const form = new URLSearchParams();
  form.set("uid", uid);
  form.set("state", state);
  form.set("client_id", cfg.clientId);
  form.set("client_secret", cfg.clientSecret);

  const { data, status } = await postBody(cfg.authEndpoint, form.toString(), fetchFn);

  // 交換成功で返る access_token/refresh_token を保存（＝以後の通常APIで使う初期トークン）。
  await persistRotatedTokens(store, { accessToken: "", refreshToken: "" }, data);

  if (data?.result !== "success") {
    throw new NeApiError(data?.code || `http_${status}`, data?.message || "NE auth exchange failed");
  }
  return data;
}

/**
 * MakeShop GraphQL トランスポート（固定トークン方式・ローテーションなし）
 *
 * 公式サンプル（developers.makeshop.jp/guide/samplequery.html）準拠のヘッダーを付けて POST する:
 *   authorization: Bearer <ACCESS_TOKEN>
 *   x-api-key:     <API_KEY>
 *   x-timestamp:   <現在のUNIXタイムスタンプ(秒)>   ← リクエストごとに生成（保存不要）
 *   content-type:  application/json
 * ボディ: { query, variables, operationName }
 * ★POST 先は .env の MAKESHOP_API_ENDPOINT を **そのまま** 使う（末尾にパスやスラッシュを足さない）。
 *
 * NE と違い access/refresh の更新は無い（固定・無期限）。ここは通信のみ。マッピングは coupon.ts の責務。
 *
 * ★診断（diagnostics）: 404 等の切り分けのため、**実際に叩いた URL・メソッド・ヘッダーのキー名（値は伏せる）・
 *   HTTPステータス・レスポンス生本文** を必ず返す。HTTPエラーや非JSONでも throw せず結果に載せて返すので、
 *   呼び出し側（管理テスト）で「どこへ何を送って何が返ったか」をそのまま確認できる。
 */

import { makeshopConfig } from "../config/makeshop";

type FetchFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface MakeshopCallDeps {
  fetchFn?: FetchFn;
  /** テスト用に x-timestamp を固定したいとき（既定は現在のUNIX秒）。 */
  nowSeconds?: number;
}

/** 送信内容と応答の診断情報（秘匿値=トークン/キーの値は含めない。キー名のみ）。 */
export interface MakeshopDiagnostics {
  /** 実際に POST した完全なURL（.env の値そのまま）。 */
  url: string;
  method: string;
  /** 送ったヘッダーのキー名一覧（値は伏せる）。authorization / x-api-key / x-timestamp / content-type を確認するため。 */
  headerKeys: string[];
  /** レスポンスの HTTP ステータス（fetch 例外時は 0）。 */
  httpStatus: number;
  /** レスポンスの生本文（先頭を切り詰め。HTMLエラーページ等もそのまま見える）。 */
  bodyText: string;
}

/** GraphQL 呼び出し結果（成功は data、検証/実行エラーは errors[]、通信は diagnostics）。 */
export interface MakeshopResult<T = unknown> {
  /** パース可能な GraphQL 応答（data か errors）が得られたか。HTTP 404・非JSON・未設定は false。 */
  ok: boolean;
  data?: T;
  errors?: Array<{ message: string; [k: string]: unknown }>;
  diagnostics: MakeshopDiagnostics;
}

/**
 * GraphQL を1回 POST し、結果と診断情報を返す（HTTPエラー・非JSONでも throw しない）。
 *   - エンドポイント/資格情報が空 → ok:false・diagnostics に理由（env未反映/secret未注入の切り分け）。
 *   - fetch 例外（DNS/接続）→ ok:false・httpStatus:0・bodyText にエラー。
 *   - HTTP 応答あり → 本文をJSONパース。data か errors があれば ok:true。それ以外（404のHTML等）は ok:false。
 */
export async function makeshopGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  deps: MakeshopCallDeps = {},
): Promise<MakeshopResult<T>> {
  const cfg = makeshopConfig();
  const url = cfg.endpoint;
  const method = "POST";
  const ts = deps.nowSeconds ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "authorization": `Bearer ${cfg.accessToken}`,
    "x-api-key": cfg.apiKey,
    "x-timestamp": String(ts),
    "content-type": "application/json",
  };
  const headerKeys = Object.keys(headers);

  // 設定不足（env未反映 / secret未注入）を診断で切り分けられるようにする。
  if (!url) {
    return { ok: false, diagnostics: { url: "", method, headerKeys, httpStatus: 0, bodyText: "MAKESHOP_API_ENDPOINT が空です（.env 未反映の可能性）" } };
  }
  if (!cfg.accessToken || !cfg.apiKey) {
    return { ok: false, diagnostics: { url, method, headerKeys, httpStatus: 0, bodyText: "ACCESS_TOKEN / API_KEY が未注入です（この関数に Secret が attach されていない可能性）" } };
  }

  const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const body = JSON.stringify({ query, variables, operationName: null });

  let httpStatus = 0;
  let bodyText = "";
  try {
    const res = await fetchFn(url, { method, headers, body });
    httpStatus = res.status;
    bodyText = await res.text();
  } catch (e) {
    return { ok: false, diagnostics: { url, method, headerKeys, httpStatus: 0, bodyText: `fetch error: ${e instanceof Error ? e.message : String(e)}` } };
  }

  const diagnostics: MakeshopDiagnostics = { url, method, headerKeys, httpStatus, bodyText: bodyText.slice(0, 2000) };

  let json: { data?: T; errors?: Array<{ message: string }> };
  try {
    json = JSON.parse(bodyText);
  } catch (_e) {
    // 非JSON（404のHTMLページ等）。bodyText をそのまま見せて切り分ける。
    return { ok: false, diagnostics };
  }
  return { ok: !!(json.data || (json.errors && json.errors.length)), data: json.data, errors: json.errors, diagnostics };
}

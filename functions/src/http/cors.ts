/**
 * HTTP関数用の CORS ヘルパー（共通 / label-system に準拠）
 *
 * onRequest の cors:true はエミュレータ等で preflight に確実応答しないことがあるため、
 * CORSヘッダを明示設定する方式を共通化する。
 *
 * セキュリティ方針:
 *   - 要求元オリジンをそのまま許可（Cookie は使わず、認証は Authorization: Bearer IDトークンで行う）。
 *   - 本番で締めたくなったら Access-Control-Allow-Origin を正規ドメインに限定する。
 */

export type ReqHeaders = Record<string, string | string[] | undefined>;
export interface CorsResponse {
  set(field: string, value: string): unknown;
}

/** すべての応答（成功・エラー・preflight）に CORS ヘッダを付与する。 */
export function applyCors(headers: ReqHeaders, res: CorsResponse, methods = "GET, POST, OPTIONS"): void {
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  res.set("Access-Control-Allow-Origin", origin || "*");
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", methods);
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age", "3600");
}

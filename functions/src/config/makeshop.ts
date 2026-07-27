/**
 * MakeShop 連携の設定参照点（固定トークン方式）
 *
 * 秘匿値（ACCESS_TOKEN / API_KEY）は Secret Manager から**注入された関数の中でのみ** process.env に入る
 * （makeshop/secrets.ts の defineSecret を関数の secrets に宣言）。
 * 非秘匿のエンドポイントURLは .env（MAKESHOP_API_ENDPOINT）で管理する。
 *
 * ここは静的な設定を読むだけ（NE の config/env.ts に相当）。トークンローテーションは無い。
 */

export interface MakeshopConfig {
  /** GraphQL エンドポイントURL（.env / MakeShop 発行）。未設定は空（isMakeshopConfigured で弾く）。 */
  endpoint: string;
  /** 固定アクセストークン（Secret Manager 注入。authorization: Bearer に載せる）。 */
  accessToken: string;
  /** 固定 APIキー（Secret Manager 注入。x-api-key に載せる）。 */
  apiKey: string;
}

/** MakeShop 設定を環境変数から読む。注入されていない関数では accessToken/apiKey は空になる。 */
export function makeshopConfig(): MakeshopConfig {
  return {
    endpoint: process.env.MAKESHOP_API_ENDPOINT || "",
    accessToken: process.env.MAKESHOP_ACCESS_TOKEN || "",
    apiKey: process.env.MAKESHOP_API_KEY || "",
  };
}

/**
 * クーポン発行に必要な設定（エンドポイント＋2つの固定資格情報）が揃っているか。
 * 揃っていない関数から呼ぶと false（＝発行しない・dormant）。
 */
export function isMakeshopConfigured(): boolean {
  const c = makeshopConfig();
  return !!c.endpoint && !!c.accessToken && !!c.apiKey;
}

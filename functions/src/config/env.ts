/**
 * 環境変数の参照点（NE連携の設定 / design.md 第6章・第8章）
 *
 * 秘匿値（client_id / client_secret / トークン）は .env 管理で **絶対にコミットしない**（.gitignore 済み）。
 * ローテーションする access/refresh トークンは .env ではなく Firestore（ne/tokens.ts）に保持する。
 * ここでは静的な設定（client_id/secret・APIベース・投入モード・受注登録エンドポイント）のみ読む。
 */

import { NE_MODE } from "./constants";

export interface NeConfig {
  /** 投入モード（auto: Cloud Functions から NE API / csv: CSV出力で手動・日次取込）。既定は安全側の csv。 */
  mode: string;
  clientId: string;
  clientSecret: string;
  /** NE APIベースURL（既定 https://api.next-engine.org）。 */
  apiBase: string;
  /** 受注登録APIのパス。★NE APIリファレンスで確定するまで空（未設定＝自動投入は無効）。 */
  orderEndpoint: string;
}

/** NE 設定を環境変数から読む。未設定は空文字（自動投入は isNeAutoConfigured で弾く）。 */
export function neConfig(): NeConfig {
  return {
    mode: process.env.NE_MODE || NE_MODE.CSV,
    clientId: process.env.NE_CLIENT_ID || "",
    clientSecret: process.env.NE_CLIENT_SECRET || "",
    apiBase: process.env.NE_API_BASE || "https://api.next-engine.org",
    orderEndpoint: process.env.NE_ORDER_ENDPOINT || "",
  };
}

/**
 * 自動投入が有効か（fail-safe の既定は無効）。
 * mode=auto かつ client_id/secret・受注登録エンドポイントが揃っているときだけ true。
 * 揃うまで（＝マッピング仕様確定前）は false → Firestoreトリガーは何もせず pending のまま、
 * CSV 側で拾える状態を保つ。
 */
export function isNeAutoConfigured(): boolean {
  const c = neConfig();
  return c.mode === NE_MODE.AUTO && !!c.clientId && !!c.clientSecret && !!c.orderEndpoint;
}

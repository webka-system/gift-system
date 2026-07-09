/**
 * 環境変数の参照点（NE連携の設定 / design.md 第6章・第8章）
 *
 * 秘匿値（client_id / client_secret / トークン）は .env 管理で **絶対にコミットしない**（.gitignore 済み）。
 * ローテーションする access/refresh トークンは .env ではなく Firestore（ne/tokens.ts）に保持する。
 * ここでは静的な設定（client_id/secret・APIベース・投入モード・受注登録エンドポイント）のみ読む。
 */

import { NE_MODE } from "./constants";

/**
 * 取り込み先店舗（＝「店舗2」）の識別子プレースホルダ。
 *
 * 運用要件: gift-system 由来（カタログギフト）の受注を、NE 上では **「店舗2」の受注**として登録したい
 * （月次集計が店舗単位のため、カタログギフト商品は店舗2として集計する必要がある）。
 * 対象店舗は NE 管理画面上で「**2:九州お取り寄せ本舗(makeshop)(ネクストエンジンカート)**」と表示されており、
 * 先頭の「2」が店舗コード（店舗ID）と思われる。
 *
 * NE の重要な前提: **どの店舗の受注かは CSV の列では指定しない。** 受注登録API/受注一括登録の際に、
 * 店舗（店舗コード、または店舗に紐づく受注一括登録パターンID）を指定することで店舗が決まる。
 *   - 店舗コードで直接指定するのか、店舗2に紐づく受注一括登録パターンIDで指定するのかは、使用する NE API の
 *     仕様に依存する（審査後の実接続時に developer.next-engine.com のAPIドキュメントで確定）。
 *   - CSV 取り込み: CSV自体には店舗列を持たせない。取り込み時に NE 側で「店舗2の受注一括登録パターン」を選ぶ運用。
 *
 * ★TODO(NE): 正確な指定方法（店舗コード指定 or パターンID指定・パラメータ名）は実接続時に確定する。
 *   今は両方の枠をプレースホルダで用意しておき、後から差し込む（環境変数でも上書き可）。
 */
// 店舗コード（店舗ID）。表示名「2:九州お取り寄せ本舗(makeshop)」から仮置き。実接続時に確定。
export const NE_STORE_CODE = process.env.NE_STORE_CODE || "2";
// 受注一括登録パターンID（店舗2のパターン）。★NE管理画面 /api_v1_receiveorder_uploadpattern/info で確認して差し込む。
export const NE_UPLOAD_PATTERN_ID = process.env.NE_UPLOAD_PATTERN_ID || ""; // 例: "" → 店舗2のパターンIDに差し替え

export interface NeConfig {
  /** 投入モード（auto: Cloud Functions から NE API / csv: CSV出力で手動・日次取込）。既定は安全側の csv。 */
  mode: string;
  clientId: string;
  clientSecret: string;
  /** NE APIベースURL（既定 https://api.next-engine.org）。 */
  apiBase: string;
  /** 受注登録APIのパス。★NE APIリファレンスで確定するまで空（未設定＝自動投入は無効）。 */
  orderEndpoint: string;
  /** 取り込み先店舗コード（＝店舗2 / 表示「2:九州お取り寄せ本舗(makeshop)」）。仮置き "2"。 */
  storeCode: string;
  /** 受注一括登録パターンID（店舗2のパターン）。店舗コード指定でない場合はこちらで店舗が決まる。未設定＝実接続前。 */
  uploadPatternId: string;
}

/** NE 設定を環境変数から読む。未設定は空文字（自動投入は isNeAutoConfigured で弾く）。 */
export function neConfig(): NeConfig {
  return {
    mode: process.env.NE_MODE || NE_MODE.CSV,
    clientId: process.env.NE_CLIENT_ID || "",
    clientSecret: process.env.NE_CLIENT_SECRET || "",
    apiBase: process.env.NE_API_BASE || "https://api.next-engine.org",
    orderEndpoint: process.env.NE_ORDER_ENDPOINT || "",
    storeCode: NE_STORE_CODE,
    uploadPatternId: NE_UPLOAD_PATTERN_ID,
  };
}

/**
 * 受け取り者URL・QRの生成に使う公開ホスト（design.md 4.2）。
 * 例: https://gift-system-f33b5.web.app。未設定なら本番の既定ドメインにフォールバック。
 * 末尾スラッシュは正規化して除去する。
 */
export function publicHostingOrigin(): string {
  const raw = process.env.PUBLIC_HOSTING_ORIGIN || "https://gift-system-f33b5.web.app";
  return raw.replace(/\/+$/, "");
}

/**
 * 自動投入が有効か（fail-safe の既定は無効）。
 * mode=auto かつ client_id/secret・受注登録エンドポイント・**取り込み先店舗の識別子**（店舗コード or
 * 受注一括登録パターンID のいずれか）が揃っているときだけ true。揃うまで（＝マッピング/店舗指定の確定前）は
 * false → Firestoreトリガーは何もせず pending のまま、CSV 側で拾える状態を保つ。
 * ※ 店舗識別子を条件に含めることで、店舗指定が無いまま誤って別店舗に登録する事故を防ぐ。
 */
export function isNeAutoConfigured(): boolean {
  const c = neConfig();
  return c.mode === NE_MODE.AUTO && !!c.clientId && !!c.clientSecret && !!c.orderEndpoint
    && (!!c.storeCode || !!c.uploadPatternId);
}

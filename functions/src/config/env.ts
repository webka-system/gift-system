/**
 * 環境変数の参照点（NE連携の設定 / design.md 第6章・第8章）
 *
 * 秘匿値（client_id / client_secret / トークン）は .env 管理で **絶対にコミットしない**（.gitignore 済み）。
 * ローテーションする access/refresh トークンは .env ではなく Firestore（ne/tokens.ts）に保持する。
 * ここでは静的な設定（client_id/secret・APIベース・投入モード・受注登録エンドポイント）のみ読む。
 */

import { NE_MODE } from "./constants";

/**
 * 取り込み先店舗（＝「店舗2」）の識別子。NEリファレンス調査で確定した内容（実接続は審査後）。
 *
 * 運用要件: gift-system 由来（カタログギフト）の受注を、NE 上では **「店舗2」の受注**として登録したい
 * （月次集計が店舗単位のため、カタログギフト商品は店舗2として集計する必要がある）。
 * 対象店舗は NE 管理画面上で「**2:九州お取り寄せ本舗(makeshop)(ネクストエンジンカート)**」と表示。
 *
 * ★調査で確定したこと:
 *   - 受注の投入は **受注伝票アップロードAPI /api_v1_receiveorder_base/upload**。
 *     どの店舗の受注かは **CSVの列では指定せず**、パラメータ **receive_order_upload_pattern_id
 *     （受注一括登録パターンID）** で決まる（＝この設計は正しかった）。
 *
 * ★紛らわしい3つの番号を区別すること（混同するとエラー）:
 *   (a) 店舗コード receive_order_shop_id … 「2:九州お取り寄せ本舗」の「2」はこれ（店舗そのものの番号）。
 *   (b) 受注一括登録パターンID receive_order_upload_pattern_id … **アップロードAPIに渡すのはこれ**。(a)とは別番号。
 *   (c) フォーマットパターンID … さらに別物（汎用標準パターン=90 等）。(b)と混同しないこと。
 *
 * ★重要: 店舗コード「2」をそのまま receive_order_upload_pattern_id に入れて動く保証はない（NE公式回答）。
 *   パターンIDは **受注一括登録パターン情報取得API /api_v1_receiveorder_uploadpattern/info** を叩き、
 *   レスポンスから **receive_order_upload_pattern_shop_id = 2（=NE_STORE_CODE）** のパターンを照合して
 *   動的に特定するのが正（固定値の決め打ちは非推奨）。→ ne/upload-pattern.ts にスタブを用意。
 */
// (a) 店舗コード receive_order_shop_id。「2:九州お取り寄せ本舗」の「2」。パターンIDの照合キーに使う（下記参照）。
export const NE_STORE_CODE = process.env.NE_STORE_CODE || "2";
// (b) アップロードAPIに渡す受注一括登録パターンID。**store code(2)とは別番号**。
//   ★実値は info API で店舗2の gift 用パターンを照合して特定して設定する（ne/upload-pattern.ts の
//     resolveUploadPatternId("2", deps, { nameContains: "ギフトカード" })）。決め打ちしない。未設定（空）＝実接続前。
//   ★想定値: **店舗2のギフトカード用パターンID = 11**（gift用に新規作成・フォーマット90/汎用。resolveUploadPatternId が
//     返すべき値・検算用。ne/upload-pattern.ts の NE_KNOWN_PATTERN_ID_SHOP2）。
//     ※ 店舗2にはもう1つ makeshop実受注用パターン4（フォーマット100035）があるが、これは gift 用ではない。
//   ★パターン11は現在 deleted_flag=無効。**実接続前に NE 管理画面で店舗2のパターン11（ギフトカード）を有効化**すること
//     （無効/存在しないIDでアップロードすると「存在しない受注一括登録パターン」エラーで弾かれる）。
export const NE_UPLOAD_PATTERN_ID = process.env.NE_UPLOAD_PATTERN_ID || "";

export interface NeConfig {
  /** 投入モード（auto: Cloud Functions から NE API / csv: CSV出力で手動・日次取込）。既定は安全側の csv。 */
  mode: string;
  /** クライアントID（/api_neauth 交換専用。Secret Manager から neCallback にのみ注入）。 */
  clientId: string;
  /** クライアントシークレット（/api_neauth 交換専用。Secret Manager から neCallback にのみ注入）。 */
  clientSecret: string;
  /** NE APIベースURL（既定 https://api.next-engine.org）。 */
  apiBase: string;
  /** 認証交換APIのパス（uid+state+client_id+client_secret → access/refresh）。既定 /api_neauth。 */
  authEndpoint: string;
  /** 受注伝票アップロードAPIのパス（実証済みCSVを投入）。既定 /api_v1_receiveorder_base/upload。 */
  uploadEndpoint: string;
  /** アップロードキュー検索APIのパス（que_id で取込結果を確認）。既定 /api_v1_system_que/search。 */
  queEndpoint: string;
  /** アップロードの wait_flag（"1"=メイン機能過負荷でも極力エラーにせず実行）。既定 "1"。 */
  waitFlag: string;
  /** 店舗コード receive_order_shop_id（＝店舗2 の「2」）。パターンID特定時の照合キー。アップロードには直接使わない。 */
  storeCode: string;
  /** アップロードAPIに渡す受注一括登録パターンID（store codeとは別番号・数値=11）。未設定＝実接続前。 */
  uploadPatternId: string;
}

/** NE 設定を環境変数から読む。未設定は空文字/既定（自動投入は isNeAutoConfigured で弾く）。 */
export function neConfig(): NeConfig {
  return {
    mode: process.env.NE_MODE || NE_MODE.CSV,
    // client_id/secret は Secret Manager から注入された関数でのみ値が入る（neCallback）。
    clientId: process.env.NE_CLIENT_ID || "",
    clientSecret: process.env.NE_CLIENT_SECRET || "",
    apiBase: process.env.NE_API_BASE || "https://api.next-engine.org",
    authEndpoint: process.env.NE_AUTH_ENDPOINT || "/api_neauth",
    uploadEndpoint: process.env.NE_UPLOAD_ENDPOINT || "/api_v1_receiveorder_base/upload",
    queEndpoint: process.env.NE_QUE_ENDPOINT || "/api_v1_system_que/search",
    waitFlag: process.env.NE_WAIT_FLAG || "1",
    // storeCode / uploadPatternId は他フィールドと同様に**呼び出し時**に process.env を読む
    //  （NE_STORE_CODE / NE_UPLOAD_PATTERN_ID の既定と一致。const は後方互換のため残置）。
    storeCode: process.env.NE_STORE_CODE || NE_STORE_CODE,
    uploadPatternId: process.env.NE_UPLOAD_PATTERN_ID || NE_UPLOAD_PATTERN_ID,
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

/** 投入経路の設定（エンドポイント・パターンID）が揃っているか。mode に依存しない共通条件。 */
function neSubmitConfigReady(): boolean {
  const c = neConfig();
  // アップロードで店舗を決めるのは receive_order_upload_pattern_id。未設定のまま投入しない（別店舗誤登録防止）。
  // client_id/secret には依存させない（投入経路は access/refresh のみで動く。認証交換専用のため neCallback にだけ注入）。
  return !!c.uploadEndpoint && !!c.uploadPatternId;
}

/**
 * 手動投入（adminRetryNeSubmissions）が有効か。**mode=auto または manual** かつ投入設定が揃っているとき true。
 * manual は「自動トリガーは動かさず、管理画面からの手動投入だけ許可」する段階テスト/慎重運用向けモード。
 * 揃うまでは false（CSV 運用と同じ＝pending のまま）。
 */
export function isNeSubmitEnabled(): boolean {
  const mode = neConfig().mode;
  return (mode === NE_MODE.AUTO || mode === NE_MODE.MANUAL) && neSubmitConfigReady();
}

/**
 * **自動トリガー**（onGiftCardConfirmed による確定時の自動投入）が有効か（fail-safe の既定は無効）。
 * **mode=auto** かつ投入設定が揃っているときだけ true。manual/csv では false → トリガーは何もせず pending のまま。
 * ※ storeCode(=2) は既定で入っているが、それだけでは投入しない。パターンID(=11)の設定が必須。
 */
export function isNeAutoConfigured(): boolean {
  return neConfig().mode === NE_MODE.AUTO && neSubmitConfigReady();
}

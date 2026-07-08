/*
 * Firebase Web アプリ設定（管理画面 web/admin 用）
 *
 * ★ 2系統を明確に分ける（label-system に準拠）：
 *   - 本番（実Firebase）   : PROD_CONFIG。実 apiKey/appId を Firebase コンソールから取得して差し替える。
 *   - エミュレータ（ローカル）: EMULATOR_CONFIG。ダミー値で動く（Auth エミュレータは apiKey を検証しない）。
 *     localhost / 127.0.0.1（または ?authEmulator=）で開くと自動でこちらを使う。
 *
 * apiKey は「公開情報」（クライアントに配られる前提の値で、秘密鍵ではない）。実際の保護は Functions の
 * 認証（IDトークン検証）と firestore.rules で行う（design.md 第8章）。
 */

// ── 本番（実Firebase）──────────────────────────────────────────────
// Firebase コンソール →「プロジェクトの設定」→「全般」→「マイアプリ（Webアプリ）」の構成からコピーした実値。
// projectId は確定済み。★ apiKey / appId / messagingSenderId は下の "TODO_..." をコンソールの実値に差し替える。
//   （これらは Web の公開設定＝クライアント埋め込み前提・秘密鍵ではない＝コミット可）
const PROD_CONFIG = {
  apiKey: "AIzaSyBHkRUODW_19CYhUwZRGjUGCB9_sA7pFNg",
  authDomain: "gift-system-f33b5.firebaseapp.com",
  projectId: "gift-system-f33b5",
  storageBucket: "gift-system-f33b5.firebasestorage.app",
  messagingSenderId: "709387761372",
  appId: "1:709387761372:web:ac7de8941ed3144bbca619",
};

// ── エミュレータ（ローカル確認用・ダミーで動く。差し替え不要）─────────────────────
// projectId は emulators 起動時のプロジェクトと一致させること（Auth はユーザーをプロジェクト単位で保持）。
const EMULATOR_PROJECT_ID = "demo-gift-system";
const EMULATOR_CONFIG = {
  apiKey: "demo-api-key", // ダミー（弾かれない既知の値）。Auth エミュレータは検証しない。
  authDomain: `${EMULATOR_PROJECT_ID}.firebaseapp.com`,
  projectId: EMULATOR_PROJECT_ID,
  appId: "demo-app-id",
};

/** Auth エミュレータに接続すべきならその URL を返す（なければ null＝本番Authを使う）。 */
export function authEmulatorUrl() {
  const forced = new URLSearchParams(location.search).get("authEmulator");
  if (forced) return forced;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:9099";
  }
  return null;
}

/** いまエミュレータ接続か（＝ダミー設定を使うか）。 */
export function isUsingAuthEmulator() {
  return authEmulatorUrl() !== null;
}

/** 接続先に応じた Firebase 設定を返す（エミュ→ダミー / 本番→実値）。 */
export function getFirebaseConfig() {
  return isUsingAuthEmulator() ? EMULATOR_CONFIG : PROD_CONFIG;
}

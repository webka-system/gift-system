/*
 * 管理画面 web/admin の Firebase Authentication ラッパー（メール/パスワード）
 *
 * ・Firebase の Web SDK（modular v10）を CDN(gstatic) から読み込む。
 * ・ログイン成功で得た IDトークンを、管理API（/api/admin*）の Authorization: Bearer に付ける。
 * ・localhost / 127.0.0.1（または ?authEmulator=）では Auth エミュレータに接続して確認できる。
 * ・アカウントは管理者がコンソール等で発行する前提（一般公開のサインアップは持たない）。
 */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirebaseConfig, authEmulatorUrl } from "./firebase-config.js";

// initializeApp は1度だけ（db.js と共有するため getApps で二重初期化を避ける）。
const app = getApps().length ? getApps()[0] : initializeApp(getFirebaseConfig());
const auth = getAuth(app);

// エミュレータ接続（指定時のみ）。initializeApp 直後・他のAuth呼び出し前に行う。
const emu = authEmulatorUrl();
if (emu) {
  try {
    connectAuthEmulator(auth, emu, { disableWarnings: true });
    console.info(`[admin-auth] Auth エミュレータに接続: ${emu}（project=${app.options.projectId}）`);
  } catch (_) {
    /* 既に接続済み等。無視 */
  }
}

// 認証状態をブラウザに保持（タブを開き直してもログイン維持）。
setPersistence(auth, browserLocalPersistence).catch(() => {});

/** 初期化済みの Firebase App（db.js が同一 App を使うために共有）。 */
export function firebaseApp() {
  return app;
}

/** 認証状態の変化を購読。cb(user|null) が呼ばれる。 */
export function onAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

/** メール/パスワードでログイン。失敗時は例外（err.code を持つ）。 */
export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

/** ログアウト。 */
export function logout() {
  return signOut(auth);
}

/** 現在のユーザーのIDトークン（未ログインなら null）。 */
export async function idToken() {
  const u = auth.currentUser;
  return u ? await u.getIdToken() : null;
}

/** ログイン失敗コード → 日本語メッセージ（情報を出し過ぎない無難な文言）。 */
export function loginErrorMessage(code) {
  switch (code) {
    case "auth/invalid-email":
      return "メールアドレスの形式が正しくありません。";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "メールアドレスまたはパスワードが違います。";
    case "auth/user-disabled":
      return "このアカウントは無効化されています。";
    case "auth/too-many-requests":
      return "試行が多すぎます。しばらく待って再度お試しください。";
    case "auth/network-request-failed":
      return "通信に失敗しました。接続をご確認ください。";
    default:
      return "ログインできませんでした。設定と認証状態をご確認ください。";
  }
}

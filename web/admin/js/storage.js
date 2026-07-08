/*
 * 管理画面 web/admin の Cloud Storage 層（商品画像アップロード）
 *
 * 選定可能商品の画像（design.md 3.2 imageUrl）を Firebase Storage の products/ 配下に保存し、
 * ダウンロードURLを返す。書き込みはログイン必須（storage.rules）。閲覧は受け取り者向けに公開。
 * Firebase App は auth.js が初期化したものを共有する。
 */

import {
  getStorage,
  connectStorageEmulator,
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { firebaseApp } from "./auth.js";

const storage = getStorage(firebaseApp());

if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  try {
    connectStorageEmulator(storage, "127.0.0.1", 9199);
  } catch (_) {
    /* 既に接続済み等。無視 */
  }
}

/**
 * 商品画像をアップロードしてダウンロードURLを返す。
 * 保存先: products/<cardTypeId>/<timestamp>_<safeName>
 * ※ ファイル名は衝突・URL事故を避けるため簡易サニタイズする。
 */
export async function uploadProductImage(cardTypeId, file) {
  const stamp = Date.now();
  const safeName = String(file.name || "image").replace(/[^\w.\-]+/g, "_");
  const path = `products/${cardTypeId}/${stamp}_${safeName}`;
  const r = storageRef(storage, path);
  await uploadBytes(r, file, { contentType: file.type || "application/octet-stream" });
  return await getDownloadURL(r);
}

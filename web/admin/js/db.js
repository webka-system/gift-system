/*
 * 管理画面 web/admin の Firestore データ層（クライアント直Firestore）
 *
 * ハイブリッド構成のうち **クライアント直Firestore** の担当:
 *   - カード種別（giftCardTypes）と選定可能商品（selectableProducts）の CRUD。
 *   - 発行済QRカード（giftCards）の一覧・memo更新（生成と受け取り者確定は Functions 側）。
 * すべて Firebase Auth ログイン必須（firestore.rules）。
 *
 * コレクション名・ステータスは /shared/constants.js（SSOT）を参照（ベタ書きしない）。
 * Firebase App は auth.js が初期化したものを共有する（二重初期化を避ける）。
 */

import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseApp } from "./auth.js";
import { COLLECTIONS, CARD_STATUS, CARD_KIND } from "/shared/constants.js";

const db = getFirestore(firebaseApp());

// ローカル（localhost/127.0.0.1）では Firestore エミュレータへ。
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  try {
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
  } catch (_) {
    /* 既に接続済み等。無視 */
  }
}

// ===== カード種別（giftCardTypes / 親）=====

/** 種別を全件取得（価格の昇順）。 */
export async function listCardTypes() {
  const q = query(collection(db, COLLECTIONS.GIFT_CARD_TYPES), orderBy("price", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** 種別を新規作成。expiryDays は正の整数のときだけ保存（未設定＝無期限）。 */
export async function createCardType({ name, price, cardProductCode, expiryDays, active = true }) {
  const data = { name, price, cardProductCode, active, createdAt: serverTimestamp() };
  if (Number.isInteger(expiryDays) && expiryDays > 0) data.expiryDays = expiryDays;
  const ref = await addDoc(collection(db, COLLECTIONS.GIFT_CARD_TYPES), data);
  return ref.id;
}

/** 種別を更新（部分更新）。 */
export function updateCardType(id, patch) {
  return updateDoc(doc(db, COLLECTIONS.GIFT_CARD_TYPES, id), patch);
}

/** 種別更新用: expiryDays を削除するためのフィールドセンチネル（無期限に戻す時に使う）。 */
export { deleteField };

/** 種別の有効/無効を切り替え。 */
export function setCardTypeActive(id, active) {
  return updateDoc(doc(db, COLLECTIONS.GIFT_CARD_TYPES, id), { active });
}

// ===== クーポン種別（giftCardTypes の kind=coupon / 株主優待）=====
// 割引内容だけを持つ（price/cardProductCode/選定商品は持たない）。有効期限はQR生成(ロット)ごとに指定する。
// ★listCardTypes は orderBy("price") のため price を持たないクーポン種別は返らない＝カタログ一覧は自動的に catalog のみ。

/** クーポン種別を全件取得（kind=coupon）。price を持たないため listCardTypes とは別クエリ。名前順。 */
export async function listCouponTypes() {
  const q = query(collection(db, COLLECTIONS.GIFT_CARD_TYPES), where("kind", "==", CARD_KIND.COUPON));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
}

/**
 * クーポン種別を新規作成。
 *   discountType: "amount"（定額円）/ "rate"（定率%）、discountValue: 割引額または割引率。
 *   minimumPrice: 任意（正の数のときだけ保存）。会員限定・1人1回・全商品は確定仕様（shared COUPON 定数）。
 */
export async function createCouponType({ name, discountType, discountValue, minimumPrice, active = true }) {
  const couponConfig = { discountType, discountValue };
  if (Number.isFinite(minimumPrice) && minimumPrice > 0) couponConfig.minimumPrice = minimumPrice;
  const data = { kind: CARD_KIND.COUPON, name, couponConfig, active, createdAt: serverTimestamp() };
  const ref = await addDoc(collection(db, COLLECTIONS.GIFT_CARD_TYPES), data);
  return ref.id;
}

// 更新・有効/無効切替は catalog と同じ汎用関数（updateCardType / setCardTypeActive）を再利用する。

// ===== 選定可能商品（selectableProducts / 子）=====

/** 指定種別に紐づく商品を取得（親子構造 / design.md 3.2）。 */
export async function listProductsByType(cardTypeId) {
  const q = query(
    collection(db, COLLECTIONS.SELECTABLE_PRODUCTS),
    where("cardTypeId", "==", cardTypeId),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** 商品を新規作成（cardTypeId で親種別に紐づける）。 */
export async function createProduct({
  cardTypeId, name, description, imageUrl, neProductCode,
  additionalImages = [], setContents = "", active = true,
}) {
  const ref = await addDoc(collection(db, COLLECTIONS.SELECTABLE_PRODUCTS), {
    cardTypeId,
    name,
    description,
    imageUrl,
    additionalImages,
    setContents,
    neProductCode,
    active,
  });
  return ref.id;
}

/** 商品を更新（部分更新）。 */
export function updateProduct(id, patch) {
  return updateDoc(doc(db, COLLECTIONS.SELECTABLE_PRODUCTS, id), patch);
}

/** 商品を削除。 */
export function deleteProduct(id) {
  return deleteDoc(doc(db, COLLECTIONS.SELECTABLE_PRODUCTS, id));
}

/** 商品1件を ID で取得（受注確認ビューで選択商品を表示するため）。 */
export async function getProductById(id) {
  if (!id) return null;
  const s = await getDoc(doc(db, COLLECTIONS.SELECTABLE_PRODUCTS, id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

// ===== 発行済QRカード（giftCards）=====
// 生成は Functions（adminGenerateGiftCards）。ここは一覧・memo更新のみ。

/** 種別で絞ってカードを一覧（生成日時の新しい順）。status で追加フィルタ可。 */
export async function listCards({ cardTypeId, status } = {}) {
  const clauses = [];
  if (cardTypeId) clauses.push(where("cardTypeId", "==", cardTypeId));
  if (status) clauses.push(where("status", "==", status));
  const q = query(
    collection(db, COLLECTIONS.GIFT_CARDS),
    ...clauses,
    orderBy("createdAt", "desc"),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** カード1件を取得。 */
export async function getCard(id) {
  const s = await getDoc(doc(db, COLLECTIONS.GIFT_CARDS, id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}

/** memo を更新（受注番号など突合用の自由記入 / design.md 3.3）。 */
export function updateCardMemo(id, memo) {
  return updateDoc(doc(db, COLLECTIONS.GIFT_CARDS, id), { memo });
}

export { CARD_STATUS };

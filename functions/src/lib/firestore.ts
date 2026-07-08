/**
 * Firestore / Admin SDK 初期化 + 型付きコレクション参照（共通基礎部品）
 *
 * 役割:
 *   firebase-admin を1度だけ初期化し、Firestore ハンドルと型付きコレクション参照を共有する。
 *   Admin SDK は firestore.rules の対象外（特権アクセス）。受け取り者による giftCards の使用
 *   （トークン照合・商品選択・住所確定・使用済み化）は、必ずこのサーバ側経路でのみ行う
 *   （design.md 第8章 / firestore.rules は受け取り者向けの口を開けない）。
 *
 * 注意:
 *   - クライアントへ db を渡さない。サーバ内部専用。
 *   - コレクション名は shared/constants.js（COLLECTIONS）由来。文字列をベタ書きしない。
 */

import { initializeApp, getApps } from "firebase-admin/app";
import {
  getFirestore,
  CollectionReference,
  FirestoreDataConverter,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { COLLECTIONS } from "../config/constants";
import { GiftCardTypeData, SelectableProductData, GiftCardData } from "../models";

// 多重初期化を避ける（エミュレータ/ホット起動対策）。
if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();

// 任意フィールド（例: shippingAddress.building）が未指定のとき undefined を書こうとして
// 例外になるのを防ぐ安全網。undefined のフィールドは黙って除外する（明示的な削除は FieldValue.delete）。
db.settings({ ignoreUndefinedProperties: true });

/**
 * 素通しの型付きコンバータ生成器。
 * Firestore ドキュメントを T（ドキュメントデータ型）として読み書きするための最小コンバータ。
 * id はドキュメント参照側で扱うため data には含めない。
 */
function converter<T extends FirebaseFirestore.DocumentData>(): FirestoreDataConverter<T> {
  return {
    toFirestore: (data: T) => data,
    fromFirestore: (snap: QueryDocumentSnapshot) => snap.data() as T,
  };
}

/** giftCardTypes（種別 / 親）への型付き参照。 */
export const giftCardTypesRef = db
  .collection(COLLECTIONS.GIFT_CARD_TYPES)
  .withConverter(converter<GiftCardTypeData>()) as CollectionReference<GiftCardTypeData>;

/** selectableProducts（選定可能商品 / 子）への型付き参照。 */
export const selectableProductsRef = db
  .collection(COLLECTIONS.SELECTABLE_PRODUCTS)
  .withConverter(converter<SelectableProductData>()) as CollectionReference<SelectableProductData>;

/** giftCards（発行済QRカード）への型付き参照。 */
export const giftCardsRef = db
  .collection(COLLECTIONS.GIFT_CARDS)
  .withConverter(converter<GiftCardData>()) as CollectionReference<GiftCardData>;

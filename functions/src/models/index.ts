/**
 * ドメイン型（Firestore データモデル / design.md 第3章）
 *
 * 3つのコレクション: giftCardTypes（親）/ selectableProducts（子）/ giftCards（発行済QR）。
 * 中心は「価格帯（親）とその中の選択肢（子）」の入れ子構造。
 *
 * 方針:
 *   - ドキュメントデータ型（Firestore に保存する形）と、id を足したアプリ表現型を分ける。
 *   - ステータス等のリテラルは shared/constants.js（CARD_STATUS / NE_STATUS）由来の型で縛る。
 *   - ここでは型定義のみ。Admin SDK の型付きコレクション参照は lib/firestore.ts で束ねる。
 */

import { Timestamp } from "firebase-admin/firestore";
import { CARD_STATUS, NE_STATUS } from "../config/constants";

// shared の列挙を値ユニオン型に落とす（例: "unused" | "used"）。
export type CardStatus = (typeof CARD_STATUS)[keyof typeof CARD_STATUS];
export type NeStatus = (typeof NE_STATUS)[keyof typeof NE_STATUS];

/** id 付きのアプリ表現（ドキュメントデータ + ドキュメントID）。 */
export type WithId<T> = T & { id: string };

// ===== 3.1 giftCardTypes（ギフトカード種別 / 親）=====
export interface GiftCardTypeData {
  /** 表示名（例:「3万円ギフトカード」）。 */
  name: string;
  /** 価格帯（例: 30000）。 */
  price: number;
  /** ギフトカード側の管理商品コード。 */
  cardProductCode: string;
  /** 作成日時。 */
  createdAt: Timestamp;
  /** 有効/無効。 */
  active: boolean;
}
export type GiftCardType = WithId<GiftCardTypeData>;

// ===== 3.2 selectableProducts（選定可能商品 / 子）=====
export interface SelectableProductData {
  /** 所属する giftCardTypes のID（種別への単純な参照。多対多は不要 / design.md 3.2）。 */
  cardTypeId: string;
  /** 商品名。 */
  name: string;
  /** 簡単な商品説明。 */
  description: string;
  /** 商品画像URL（Firebase Storage）。 */
  imageUrl: string;
  /** 選定されたとき NE へ流す実商品コード。 */
  neProductCode: string;
  /** 有効/無効。 */
  active: boolean;
}
export type SelectableProduct = WithId<SelectableProductData>;

// ===== 配送先住所（giftCards.shippingAddress / design.md 3.3）=====
export interface ShippingAddress {
  /** 氏名。 */
  name: string;
  /** 氏名カナ（全角カナ。NE の受注名カナ／発送先カナに必須）。 */
  nameKana: string;
  /** 郵便番号。 */
  postalCode: string;
  /** 都道府県。 */
  prefecture: string;
  /** 市区町村・番地。 */
  address: string;
  /** 建物名・部屋番号など（任意）。 */
  building?: string;
  /** 電話番号。 */
  phone: string;
}

// ===== 3.3 giftCards（発行済みQRカード）=====
export interface GiftCardData {
  /** 推測不可能なユニークトークン（URL用 / design.md 第8章）。 */
  token: string;
  /** どの価格帯のカードか。 */
  cardTypeId: string;
  /** unused（未使用）/ used（使用済）。 */
  status: CardStatus;
  /** 管理者が手入力する自由記入欄（受注番号など突合用）。 */
  memo: string;
  /** 生成日時。 */
  createdAt: Timestamp;
  /** 印刷用PDFに出力済みか（未印刷分の抽出用 / design.md 4.1）。生成時 false。 */
  printed?: boolean;
  /** 印刷用PDFに出力した日時。 */
  printedAt?: Timestamp;

  // ── 以下は使用（受け取り者の確定）時に書き込まれる ──
  /** 受け取り者が選んだ商品。 */
  selectedProductId?: string;
  /** 配送先住所。 */
  shippingAddress?: ShippingAddress;
  /** 受け取り者のメールアドレス（NE の受注メールアドレス。NEの受付/発送通知メール宛先 / design.md §7）。 */
  recipientEmail?: string;
  /** 配達希望日（任意 / "YYYY-MM-DD"）。確定日+MIN_DAYS〜+MAX_MONTHS の範囲。未指定はおまかせ。 */
  deliveryDate?: string;
  /** 配達希望時間帯（任意 / DELIVERY.TIME_SLOTS のいずれか）。未指定はおまかせ。 */
  deliveryTime?: string;
  /** 使用（確定）日時。 */
  usedAt?: Timestamp;
  /** NE投入状態（未投入 / 投入中 / 投入済 / CSV出力済 など）。 */
  neStatus?: NeStatus;
  /** NE自動投入に成功した日時。 */
  neSubmittedAt?: Timestamp;
  /** 直近のNE投入失敗の理由（運用調査用。顧客情報は含めない）。 */
  neLastError?: string;
  /** NE自動投入の試行回数（リトライ運用の目安）。 */
  neAttempts?: number;
}
export type GiftCard = WithId<GiftCardData>;

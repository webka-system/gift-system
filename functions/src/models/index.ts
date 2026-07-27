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
import { CARD_STATUS, NE_STATUS, CARD_KIND, COUPON_STATUS, COUPON } from "../config/constants";

// shared の列挙を値ユニオン型に落とす（例: "unused" | "used"）。
export type CardStatus = (typeof CARD_STATUS)[keyof typeof CARD_STATUS];
export type NeStatus = (typeof NE_STATUS)[keyof typeof NE_STATUS];
/** ギフトカードの種類（"catalog" | "coupon"）。未設定は "catalog" とみなす（後方互換）。 */
export type CardKind = (typeof CARD_KIND)[keyof typeof CARD_KIND];
/** クーポン発行状態（"issuing" | "issued"）。未設定は「未発行」。 */
export type CouponStatus = (typeof COUPON_STATUS)[keyof typeof COUPON_STATUS];
/** 割引方式（"amount"=定額円 | "rate"=定率%）。 */
export type CouponDiscountType = (typeof COUPON.DISCOUNT_TYPE)[keyof typeof COUPON.DISCOUNT_TYPE];

/** id 付きのアプリ表現（ドキュメントデータ + ドキュメントID）。 */
export type WithId<T> = T & { id: string };

// ===== クーポン種別設定（giftCardTypes.couponConfig / kind=coupon のときのみ）=====
// 割引内容はここに固定し、期をまたいで使い回す。有効期限はここに持たず、
// ロット（QR生成）ごとに絶対日付で指定する（giftCards.couponExpiryAt / B案）。
// 会員限定・全商品・1人1回（UENUCT4）は確定仕様のため定数（shared COUPON）側に持ち、
// 種別ごとに変える割引方式・割引額だけをここに置く。
export interface CouponConfig {
  /** 割引方式（"amount"=定額円 / "rate"=定率%）。 */
  discountType: CouponDiscountType;
  /** 割引額（discountType=amount なら円 / rate なら %）。 */
  discountValue: number;
  /** 利用最低購入金額（税込・任意）。未設定は下限なし。→ createCoupon.minimumPrice。 */
  minimumPrice?: number;
}

// ===== 3.1 giftCardTypes（ギフトカード種別 / 親）=====
// kind により catalog / coupon の2形態を持つ判別ユニオン（単一コレクション）。
// ★後方互換: kind 未設定は "catalog" とみなす（既存カタログ種別を壊さない）。
export interface GiftCardTypeData {
  /** 種類（"catalog" | "coupon"）。未設定は "catalog"。 */
  kind?: CardKind;
  /** 表示名（例:「3万円ギフトカード」/「株主優待10%OFF」）。 */
  name: string;
  /** 価格帯（例: 30000）。catalog 用（coupon では未使用）。 */
  price?: number;
  /** ギフトカード側の管理商品コード。catalog 用（coupon では未使用）。 */
  cardProductCode?: string;
  /**
   * 有効期限の日数（デフォルト）。生成日 generatedAt からこの日数で期限切れ。未設定/0以下は無期限。
   * ★catalog 用の相対期限。coupon は種別ではなくロット単位の絶対日付（couponExpiryAt）を使う。
   */
  expiryDays?: number;
  /** クーポン設定（kind=coupon のときのみ。割引方式・割引額）。 */
  couponConfig?: CouponConfig;
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
  /** 商品画像URL（Firebase Storage）。メイン画像／サムネ。 */
  imageUrl: string;
  /** 追加画像URL（任意 / 最大 PRODUCT.MAX_ADDITIONAL_IMAGES 枚。メインと合わせて詳細ギャラリーで表示）。 */
  additionalImages?: string[];
  /** セット内容（任意 / 改行区切りテキスト。1行=1項目。表示時は「・」付きリスト。説明文とは独立）。 */
  setContents?: string;
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
  /**
   * カードの種類（"catalog" | "coupon"）。生成時に種別（giftCardTypes.kind）からデノーマライズ（コピー）する。
   * 受け取り者フローの振り分け（catalog=商品選定 / coupon=クーポン表示）と一覧の絞り込みに使う。
   * ★後方互換: 未設定は "catalog" とみなす（既存カードを壊さない）。
   */
  kind?: CardKind;
  /** 推測不可能なユニークトークン（URL用 / design.md 第8章）。 */
  token: string;
  /** どの価格帯／どのクーポン種別のカードか（giftCardTypes の参照）。 */
  cardTypeId: string;
  /** unused（未使用）/ used（使用済）。coupon はクーポン発行成功で used 化。 */
  status: CardStatus;
  /** 管理者が手入力する自由記入欄（受注番号など突合用）。 */
  memo: string;
  /** 生成日時。 */
  createdAt: Timestamp;
  /** 印刷用PDFに出力済みか（未印刷分の抽出用 / design.md 4.1）。生成時 false。 */
  printed?: boolean;
  /** 印刷用PDFに出力した日時。 */
  printedAt?: Timestamp;
  /** 生成日時（ロット管理・有効期限の起点）。既存カードには無い場合がある（後方互換＝無期限扱い）。 */
  generatedAt?: Timestamp;
  /** 生成バッチID（同一の一括生成をまとめる識別子。ロット絞り込み用）。既存カードには無い場合がある。 */
  batchId?: string;
  /** 有効期限日数の個別上書き（任意）。種別デフォルトより優先。管理者が個別に期限を延長/短縮できる。 */
  expiryDaysOverride?: number;

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
  /** NE投入状態（未投入 / 投入中 / 受付済(queued) / 投入済 / CSV出力済 など）。 */
  neStatus?: NeStatus;
  /** 受注伝票アップロードAPIの que_id（非同期キューの取込結果確認に使う。queued 時に保持）。 */
  neQueId?: string;
  /** アップロードAPIに受け付けられた日時（queued 化した時刻）。 */
  neQueuedAt?: Timestamp;
  /** NE自動投入に成功した日時（キュー取込成功＝submitted になった時刻）。 */
  neSubmittedAt?: Timestamp;
  /** 直近のNE投入失敗の理由（運用調査用。顧客情報は含めない）。 */
  neLastError?: string;
  /** NE自動投入の試行回数（リトライ運用の目安）。 */
  neAttempts?: number;

  // ── クーポン（kind=coupon）専用。生成時に couponExpiryAt を焼き込み、初回アクセスで発行する ──
  /**
   * クーポンの有効期限（絶対日付 / ロット指定）。QR生成時に管理者が入力し、各カードへ焼き込む。
   * 「QRの有効期限（受け取り者ページのゲート）」と「MakeShopクーポンの有効期限（createCoupon.endedAt）」の両方に使う。
   */
  couponExpiryAt?: Timestamp;
  /** クーポン発行状態（"issuing"=発行中/claim中間 / "issued"=発行済）。未設定は未発行。 */
  couponStatus?: CouponStatus;
  /** 発行されたクーポンコード（株主向け画面に表示＋コピー。再アクセスはこれを表示するだけ）。 */
  couponCode?: string;
  /** クーポン発行に成功した日時。 */
  couponIssuedAt?: Timestamp;
  /** 直近のクーポン発行失敗の理由（MakeShop errorMessage 等。運用調査用。顧客情報は含めない）。 */
  couponLastError?: string;
  /** クーポン発行の試行回数（リトライ運用の目安）。 */
  couponAttempts?: number;

  // ── 管理者による「やり直し」（未使用へ戻す）で積まれる過去の入力履歴 ──
  /** 過去に確定された入力の履歴（やり直しのたびに、戻す直前の内容を push）。 */
  previousSubmissions?: PreviousSubmission[];
  /** 直近の管理者編集の日時（監査用）。 */
  lastEditedAt?: Timestamp;
  /** 直近に編集した管理者のメール（監査用）。 */
  lastEditedBy?: string;
}
export type GiftCard = WithId<GiftCardData>;

/**
 * 過去の確定入力のスナップショット（管理者が「未使用へ戻す」際に記録）。
 * カード本体はクリアするが、いつ何が入力されたかを履歴として残して後から参照できるようにする。
 */
export interface PreviousSubmission {
  /** 選ばれていた商品ID。 */
  selectedProductId?: string;
  /** 入力されていた配送先住所。 */
  shippingAddress?: ShippingAddress;
  /** 入力されていたメールアドレス。 */
  recipientEmail?: string;
  /** 配達希望日。 */
  deliveryDate?: string;
  /** 配達希望時間帯。 */
  deliveryTime?: string;
  /** その確定の日時（元の usedAt）。 */
  usedAt?: Timestamp;
  /** 戻した時点の NE 投入状態。 */
  neStatus?: NeStatus;
  /** 未使用へ戻した日時。 */
  resetAt: Timestamp;
  /** 未使用へ戻した管理者のメール。 */
  resetBy?: string;
}

/**
 * gift-system 共通定数（仕様の単一情報源 / Single Source of Truth）
 *
 * 設計書（docs/design.md）の値・列挙をここに集約する。
 * フロント（web/）・バックエンド（functions/）双方がこれを参照し、文字列のベタ書きを避ける。
 * 仕様変更があればここだけ直す。
 *
 * ※ ESM で書く。Hosting predeploy が web/shared/constants.js へコピーし、
 *   Functions は tsconfig の include（../shared/constants.js）経由でコンパイルして参照する。
 */

// ===== Firestore コレクション名（design.md 第3章）=====
export const COLLECTIONS = {
  GIFT_CARD_TYPES: "giftCardTypes",       // 3.1 ギフトカード種別（親）
  SELECTABLE_PRODUCTS: "selectableProducts", // 3.2 選定可能商品（子）
  GIFT_CARDS: "giftCards",                 // 3.3 発行済みQRカード
};

// ===== 発行済みQRカードのステータス（design.md 3.3）=====
export const CARD_STATUS = {
  UNUSED: "unused", // 未使用
  USED: "used",     // 使用済（受け取り者が確定 → 二重利用防止）
};

// ===== NE 投入状態（design.md 3.3 / 第6章）=====
// 「住所が確定した実商品受注のみ」を NE へ投入し、投入後にこの値を更新する。
// 状態遷移（自動）: pending → submitting → submitted（成功）/ pending（失敗時に戻す＝リトライ可能）
// 状態遷移（CSV） : pending → csv（CSV出力＝取込済み扱い）
export const NE_STATUS = {
  PENDING: "pending",       // 未投入（トリガー/CSVが拾う対象）
  SUBMITTING: "submitting", // 自動投入の処理中（claimによる二重投入防止の中間状態）
  SUBMITTED: "submitted",   // 自動連携で投入済（完了）
  CSV_EXPORTED: "csv",      // CSV出力済（手動/日次取込）
  ERROR: "error",           // 投入失敗（予約。当面は失敗時 pending に戻す運用）
};

// ===== NE 連携方式（design.md 第6章。自動・CSV の両対応）=====
export const NE_MODE = {
  AUTO: "auto", // Cloud Function から NE 受注登録 API を呼ぶ
  CSV: "csv",   // 確定済み受注を CSV 出力し手動/日次で取込
};

// ===== 受け取り者トークン =====
// 推測不可能なランダム値（外部アクセス制御の要 / design.md 第8章）。
// URL 形式は /g/<token> を想定（firebase.json hosting rewrites）。
export const TOKEN = {
  // 生成バイト数（base64url でおよそ 1.33 倍の文字数になる）。
  BYTES: 24,
  // URL パスの接頭辞。
  URL_PREFIX: "/g/",
};

// ===== QR 一括生成の上限（暴発防止のガード）=====
export const QR_GENERATION = {
  MAX_PER_BATCH: 1000, // 1回の一括生成で作れる最大枚数
};

// ===== Firestore / Storage ロケーション（design.md 第5章・第8章）=====
// ロケーションは変更不可のため東京で確定。
export const REGION = "asia-northeast1";

// ===== 印刷用URL一覧の Excel(xlsx) 出力（design.md 4.1「印刷用出力」/ 第9章 手順7）=====
// 印刷工場の入稿方式に合わせ、受け取り者URL（/g/<token>）を1行ずつ並べた Excel を出力する。
// 工場は A列（URL）だけを参照する想定。管理側の突合用に B列=token / C列=種別名 を付ける。
// 工場が「純粋なURL1列のみ」を求める場合に備え、URL_ONLY / INCLUDE_HEADER で切り替えられる。
export const URL_EXPORT = {
  // true: A列(URL)のみ。false: A=URL / B=token / C=種別名。
  URL_ONLY: false,
  // 先頭にヘッダ行を付けるか（工場が純URL列だけを求めるなら false にする）。
  INCLUDE_HEADER: true,
  // シート名。
  SHEET_NAME: "URLs",
  // 列見出し（INCLUDE_HEADER=true のとき使用）。
  HEADERS: { url: "URL", token: "token", cardTypeName: "種別名" },
  // 1回の出力で扱う最大行数（暴発防止）。
  MAX_ROWS: 5000,
};

// ===== NE 受注登録の固定値（design.md 第6章 / 受け取り者入力に無い項目）=====
// 元の購入受注と切り離されたギフト方式のため、支払は購入時に済んでいる。
// NE へは「発送のみを担う受注」として、以下の固定値で埋める。
// ※ NE 側の区分表記との最終一致は NE連携本体（審査通過後）で確認して差し替える。
export const NE_FIXED = {
  // 支払方法（購入時に支払い済み＝ポイント全額払い扱い）。NEの区分表記は後日最終確認。
  PAYMENT_METHOD: "ポイント全額払い",
  // 発送方法。★未確定★ NEが受け付ける正確な表記が決まり次第ここを差し替える（TODO(NE)）。
  SHIPPING_METHOD: "",
  // 商品価格（支払い済みギフトのため 0 円）。
  PRODUCT_PRICE: 0,
  // 受注数量（1カード=1商品 / design.md 3.3）。
  QUANTITY: 1,
};

// ===== 有効期限切れ時の問い合わせ先（受け取り者の期限切れ画面に表示。プレースホルダ・後で差し替え）=====
export const EXPIRY_CONTACT = {
  // 期限切れ画面の見出し・本文。
  heading: "このギフトの受け取り期限が過ぎています",
  body: "恐れ入りますが、受け取り可能な期間を過ぎたため、こちらのギフトはご利用いただけません。",
  // 問い合わせ先（★プレースホルダ。運用で実値に差し替える）。
  note: "ご不明な点は下記までお問い合わせください。",
  name: "（お問い合わせ窓口）",
  email: "support@example.com",
  phone: "",
};

// ===== 選定可能商品の詳細表示（追加画像・セット内容 / design.md 3.2 拡張）=====
export const PRODUCT = {
  // メイン画像（imageUrl）に加えて登録できる追加画像の最大枚数（メイン＋4＝合計5枚）。
  MAX_ADDITIONAL_IMAGES: 4,
};

// ===== 都道府県（受け取り者フォームのプルダウン / 郵便番号自動入力の値と一致）=====
// zipcloud 等の郵便番号APIが返す address1（都道府県）とそのまま一致する表記・順序。
export const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

// ===== 配達希望（受け取り者が任意で指定 / giftCards.deliveryDate・deliveryTime）=====
// フォーム・クライアント検証・サーバ検証・NEマッピングで共有する単一情報源。
export const DELIVERY = {
  // 配達希望日の選択可能範囲（受け取り者の確定日を基準）。
  //   最短: 確定日 + MIN_DAYS 日後 / 最長: 確定日 + MAX_MONTHS か月以内。
  MIN_DAYS: 14,
  MAX_MONTHS: 2,
  // 配達希望時間帯の区分（任意）。空文字＝「指定なし（おまかせ）」。
  // 値＝表示ラベル。NEの時間帯区分表記と対応が要る場合は NE 側で変換マップを持つ。
  TIME_SLOTS: [
    "午前中",
    "14:00-16:00",
    "16:00-18:00",
    "18:00-20:00",
    "19:00-21:00",
  ],
};

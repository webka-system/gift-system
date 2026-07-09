# gift-system 開発ワークログ / 進捗記録

本ドキュメントは開発の経緯・現在の到達状態・残タスクを記録するもの。
後で設計書（`docs/design.md`）へ統合できる形でまとめる。仕様の正本は `design.md`、
本ドキュメントは「いつ・何を・なぜそう解決したか」の履歴を担う。

最終更新: 2026-07-09

---

## 0. 2026-07-09：NE必須項目に合わせた受け取り者フォーム完成 ✅（未デプロイ）

NE連携の本格稼働前に、**受け取り者フォームをNEの受注CSV必須項目に合わせて完成**させた
（使用済みカードには後から項目を足せないため、稼働前に確定させる必要があった）。

### 確定した設計判断
- **NE受注者＝受け取り者本人**。NEの受注者ブロックと発送先ブロックの両方を受け取り者情報で埋める。
- **商品価格＝0円**（購入時に支払い済みのギフト。NEは発送のみ担当）。
- **店舗伝票番号＝token** を流用（新フィールド不要）。
- **支払方法＝「ポイント全額払い」**（NE区分表記との最終一致は連携本体で確認）。**発送方法は未確定**＝
  定数を空にして TODO(NE) で差し替え可能に。

### フォームに追加した項目（今回で完成）
- 氏名カナ（`nameKana` / 全角カナ・必須）
- メールアドレス（`email` / 必須）＋確認再入力（`emailConfirm` / 一致チェック）
- 配達希望日（`deliveryDate` / 任意 / 確定日+14日〜+2か月以内）
- 配達希望時間帯（`deliveryTime` / 任意 / 午前中・14-16・16-18・18-20・19-21 の5区分）
- 熨斗は実装しない（不要と確定）。

### 実装（変更ファイル）
- `shared/constants.js`：`NE_FIXED`（paymentMethod / shippingMethod=TODO / productPrice=0 / quantity=1）、
  `DELIVERY`（MIN_DAYS=14 / MAX_MONTHS=2 / TIME_SLOTS）を追加。フォーム・検証・NEマッピングで共有。
- `functions/src/models/index.ts`：`ShippingAddress.nameKana` 追加。`GiftCardData` に
  `recipientEmail` / `deliveryDate` / `deliveryTime` 追加（案A：最小変更）。
- `web/receive/index.html` + `receive.js`：カナ・メール（+確認）・配達希望日/時間帯の入力を追加。
  日付の min/max と時間帯選択肢は `DELIVERY` 定数から生成。クライアント側でも形式・一致・範囲を検証。
- `functions/src/http/receive.ts`：`validateAddress` にカナ必須＋全角カナ形式。`receiveConfirm` に
  メール（形式＋確認一致）／配達希望日（JST基準で範囲検証）／時間帯（5区分）検証を追加し、
  `recipientEmail`・（指定時のみ）`deliveryDate`/`deliveryTime` を保存。二重確定防止TXは維持。
  エラーコード：`invalid_email` / `invalid_delivery_date` / `invalid_delivery_time`（既存 invalid_address 拡張）。
- `functions/src/ne/order.ts`：NE_FIELD / buildOrderParams を§2の全項目に作り直し。受注者＝発送先の
  両ブロックを受け取り者情報で充填、住所結合（`joinAddress`）、固定値差し込み、時間帯変換
  （`NE_DELIVERY_TIME_MAP`：現状は同値・TODO(NE)）。フィールド名は全てTODO(NE)の暫定。
- `functions/src/ne/csv.ts`：`NeCsvRow` / `NE_CSV_COLUMNS` を§2の全列に作り直し（店舗伝票番号〜受注数量＋
  参考のカード種別・memo）。支払/発送/価格は NE_FIXED、時間帯は neDeliveryTime で変換。Shift-JISは維持。
- `functions/src/http/admin-ne.ts` / `ne/submit.ts`：新スキーマに合わせ CSV行・NE投入inputの組み立てを更新。
- `web/admin/js/admin.js`：詳細ビューに 氏名カナ・メール・配達希望日・時間帯の表示行を追加（表示のみ）。

### NE実接続について
実接続（トークン取得・実送信）はNE審査通過後。今回は**列構成・データ整形まで**を整え、実送信は
既存スタブ／pending運用のまま（`isNeAutoConfigured` が false の間はトリガーは何もしない）。

### 検証（エミュレータ end-to-end）
- functions+firestore エミュレータで `receiveConfirm` を実HTTPで検証（18/18 pass）：
  正常系（カナ・メール一致・範囲内日付+20日・時間帯）で200＋全項目保存＋neStatus=pending、
  指定なしで200かつ配達項目は未保存、範囲外日付（+3日/+100日）・不正時間帯・メール不一致/形式不正・
  カナ不正/未入力がそれぞれ正しいコードで400、弾かれたカードは未使用のまま。
- `buildOrderParams` のNEマッピング（受注者＝発送先の両ブロック・住所結合・固定値・時間帯）を
  コンパイル済みlibで検証（12/12 pass）。
- `functions` の lint / build / 既存ユニットテスト（20 passing。ne-csv は新スキーマへ更新）すべて緑。

### デプロイ（未実施）
- web＋functions 両方の変更のため **`firebase deploy --only hosting,functions`**。
  functions predeploy が lint/build を実行。hosting predeploy が `shared/constants.js` を web/shared へコピー。
- 新規HTTP関数の追加は無いため Cloud Run の手動public設定は不要。

### 0.1 追補（2026-07-09）：受け取り者フォームのUX調整
実機確認で出た調整。**GitHub push は解決済み**（label-system と同じ `credential.useHttpPath=true` ＋
資格情報のパス単位共存。DELISHMALL は温存、gift-system は webka-system で push）。以後は通常の `git push`。

- **メール確認欄（emailConfirm）を廃止**：メールは1欄のみ。形式チェック（type=email＋サーバ EMAIL_RE）は維持。
  サーバ `validateEmail` から確認一致チェックを削除（1引数化）。
- **郵便番号→住所の自動入力**：zipcloud API（`https://zipcloud.ibsnet.co.jp/api/search`）をクライアント直fetch。
  `access-control-allow-origin: *` を確認済み＝**プロキシ/functions不要**。7桁そろったら都道府県プルダウンと
  住所欄（市区町村＋町域）を補助的に補完。補完後も手修正可。状態を `#zip-status` に表示。
- **都道府県をプルダウン化**：`shared/constants.js` に `PREFECTURES`（47件）を追加し select を生成。
  zipcloud の `address1` は PREFECTURES と厳密一致（京都府/北海道/大阪府 等も確認）＝自動選択が全県で成立。
- **配達時間帯の表記変更**：「指定なし（おまかせ）」→「指定なし」。フォームに案内文
  「配達希望日・時間帯は任意です。指定がない場合、最短でのお届けとなります。」を表示。任意・未選択で確定可は維持。
- **CSS修正**：`.address-form` の input/select/date を同一の見た目・高さに統一（時間帯selectの枠が小さい問題を解消）。
  select はネイティブ装飾をリセットし控えめな矢印を付与、date に最小高さ、`#zip-status` の注記スタイル追加。

検証（hosting+functions+firestore エミュレータ）：配信HTMLで emailConfirm 消滅／都道府県select／案内文／
「指定なし」化を確認。`/shared/constants.js` の PREFECTURES 配信を確認。`receiveConfirm` end-to-end 19/19
（確認欄なしでも200・recipientEmail保存、他は従来どおり）。zipcloud の address1 が PREFECTURES と一致を確認。
functions lint/build/ユニットテスト（20 passing）緑。**デプロイは `firebase deploy --only hosting,functions`**
（メール確認廃止でサーバ検証も変わるため functions も必要。郵便番号APIはクライアント直＝functions追加なし）。

### 0.2 追補（2026-07-09）：グループC第一弾 — QR一覧のCSS崩れ修正＋受注検索・絞り込み
- **CSS崩れ修正**：QR一覧テーブルを `table-layout: fixed` 化し、`<colgroup>` で各列に固定幅を付与。
  長いURL/トークンでもセル枠が崩れない。テーブルは `min-width` を持ち `.table-scroll`（overflow-x:auto）で
  狭幅時は横スクロール。**受け取り者URL列**は `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`
  で「…」省略＋`title` 全文ツールチップ（開くリンク・全文コピーは維持）。**トークン列**は先頭8文字＋「…」に
  短縮（`shortToken`）し `title` で全文表示。全文は詳細ビュー・URLコピーで参照可能。
- **受注検索・絞り込み**：QR一覧にテキスト検索（名前・カナ・メール・memo・トークンの部分一致・リアルタイム）と
  NE投入状態の絞り込みを追加。種別・状態は従来どおりサーバ再取得、NE状態・検索はクライアント側フィルタ
  （取得済みの `cardsCache` に対して適用）。件数表示（`N / 全件`）付き。グループA（自動読込・ローディング）・
  グループB（ステータス色分け）と整合。
- **実装**：フィルタ本体を純粋モジュール `web/admin/js/cards-filter.js`（`shortToken`/`cardMatchesQuery`/
  `filterCards`）に切り出し、`admin.js` から利用。将来、件数が非常に多くなった場合は正規化検索フィールドの
  追加を検討（今回はクライアント側フィルタ）。
- **変更ファイル**：`web/admin/index.html`（フィルタUI・colgroup・スクロールラッパ）/
  `web/admin/js/admin.js`（取得と絞り込みの分離・トークン短縮）/ `web/admin/js/cards-filter.js`（新規）/
  `web/admin/css/admin.css`（table-layout:fixed・列幅・URL/トークン省略・検索バー）。
- **検証**：`cards-filter.js` を実コードで単体検証（22/22：短縮・各対象の部分一致・大文字小文字無視・
  NE状態フィルタ・複合・空白除去）。hosting エミュレータで配信DOM（検索/NEフィルタ/colgroup/table-scroll/
  cards-table/NE5選択肢）とCSS（fixed・ellipsis）と全アセットのMIMEを確認。web JS 構文チェック緑。
- **デプロイ（未実施）**：**web のみ＝`firebase deploy --only hosting`**（functions 変更なし・新規HTTP関数なし）。

### 0.3 追補（2026-07-09）：商品詳細の拡張（複数画像・セット内容）
selectableProducts に追加画像とセット内容を持たせ、管理画面で登録・編集、受け取り者の選択画面でも見せる。

- **データモデル**：`selectableProducts` に `additionalImages?: string[]`（最大 `PRODUCT.MAX_ADDITIONAL_IMAGES`=4枚。
  メイン `imageUrl` と合わせて最大5枚）と `setContents?: string`（改行区切り＝1行1項目。説明文とは独立）を追加。
  `shared/constants.js` に `PRODUCT.MAX_ADDITIONAL_IMAGES`。**後方互換**：欠落時は既定（[] / ""）で扱う。
- **管理画面（登録・編集）**：追加画像アップロード（複数選択・プレビュー・×削除、最大4枚。既存メイン画像は
  従来どおり選び直したときだけ差し替え）。セット内容テキストエリア（1行=1項目・空行は除去して保存）。
  既存の商品編集に読込・保存を追加。追加画像は既存URLを保持しつつ新規ファイルのみ Storage へアップロード。
- **管理画面（一覧・詳細）**：一覧は簡潔に（サムネ＋商品名＋状態、追加画像枚数バッジ）。複数画像ギャラリー・
  セット内容・説明・NEコードは「詳細」モーダルで表示（グループBの受注詳細と同じモーダル基盤）。
- **受け取り者（receiveGetCard）**：商品に `additionalImages` / `setContents` を追加で返す（欠落は []/""）。
- **受け取り者（選択画面）**：各商品カードに「詳細を見る」ボタン。タップで詳細モーダル（画像ギャラリー＝
  矢印・ドット・スワイプで切替、セット内容の箇条書き、説明文、「この商品を選ぶ」）。選択（ラジオ）挙動は維持
  ＝詳細を見たうえで選べる。既存のトークン照合・確定・自動読込ロジックは不変。
- **storage.rules は変更不要**（`products/**` が公開読み取り＋ログイン書き込み。追加画像も同じパス配下）。
- **変更ファイル**：`shared/constants.js` / `functions/src/models/index.ts` / `functions/src/http/receive.ts`
  （receiveGetCard）/ `web/admin/js/db.js`（createProduct）/ `web/admin/index.html`・`js/admin.js`・`css/admin.css`
  （追加画像UI・セット内容・一覧簡潔化・商品詳細モーダル・ギャラリー）/ `web/receive/index.html`・`js/receive.js`・
  `css/receive.css`（詳細モーダル・ギャラリー・スワイプ）。
- **検証**：`receiveGetCard` を functions+firestore エミュレータで end-to-end（10/10）＝新項目が返る＋
  **追加画像/セット内容が無い既存商品でも壊れない（[]/"" で返る）**。hosting エミュレータで管理画面フォーム
  （セット内容/追加画像input/プレビュー領域/商品詳細モーダル/一覧簡潔化）と受け取り者モーダル
  （ギャラリー/選ぶボタン/セット内容領域）と `PRODUCT` 定数配信を確認。functions lint/build/test(20) 緑・web構文緑。
- **デプロイ（未実施）**：**web＋functions＝`firebase deploy --only hosting,functions`**
  （receiveGetCard を更新。storage.rules は変更なし＝deploy不要。新規HTTP関数なし＝Cloud Run手動public不要）。

### 0.4 追補（2026-07-09）：管理者による編集・やり直し・QR生成日時（ロット管理）
管理画面の最終機能。**実装方針＝編集・やり直しは新規 Functions 経由**（理由：受け取り者と同一の
バリデーションをサーバで適用／トランザクションで状態遷移を原子的に／履歴記録・NE判定をサーバ一元化。
直Firestoreではルールで複雑検証を書けず整合性リスクが高い）。バリデータは receive と共通化。

- **共通化**：住所/カナ/メール/配達日範囲/時間帯の検証を `functions/src/http/order-fields.ts` に抽出
  （`OrderError`＋各 validator）。`receive.ts` と新 `admin-card.ts` が共有＝受け取り者と管理者で同一ルール。
- **編集（`adminUpdateGiftCard`）**：使用済みカードの受注内容（選択商品・氏名/カナ/郵便/都道府県/住所/建物/
  電話・メール・配達希望日/時間帯）を管理者が上書き。選択商品は同じ種別に限定（種別違いは invalid_product）。
  neStatus・usedAt は据え置き（NEは自動更新されない）。`lastEditedAt`/`lastEditedBy` を記録。詳細モーダルに
  「受注内容を編集」ボタン→編集フォーム、保存時に**確認ダイアログ**。
- **やり直し（`adminResetGiftCard`）**：使用済み→未使用へ戻し、受け取り者が同じURLで再入力可能に。戻す直前の
  入力を `giftCards.previousSubmissions[]`（履歴・`resetAt`/`resetBy` 付き）に push して保持。カード本体は
  status=unused に戻し selectedProductId/shippingAddress/recipientEmail/deliveryDate/Time/usedAt/neStatus 等を
  クリア（トークンは不変）。詳細モーダルに「未使用に戻す」ボタン＋**確認ダイアログ**、過去履歴の表示。
- **NE投入済み警告**：編集・やり直しの対象が NE投入済み（submitted/csv/submitting）なら、詳細と確認ダイアログに
  「NE側は自動更新されないため手動で修正してください」の警告を表示（操作はブロックしない）。
- **QR生成日時（ロット管理）**：`adminGenerateGiftCards` が各カードに `generatedAt`＋`batchId`（一括生成ごとの
  識別子）を記録。QR一覧に「生成日時」列と「ロット（生成）」絞り込みを追加（`cards-filter.js` の filterCards に
  batchId・LOT_NONE を追加）。詳細に生成日時・ロットIDを表示。**後方互換**：generatedAt/batchId が無い既存
  カードは「不明」表示・「生成日時不明」ロットにまとまる。
- **権限**：新2関数とも `requireAuth`（ログイン必須）。未認証は401（検証済み）。
- **変更ファイル**：`functions/src/http/order-fields.ts`(新) / `receive.ts`(検証を共通化) / `admin-card.ts`(新) /
  `admin-qr.ts`(generatedAt/batchId) / `models/index.ts`(GiftCardData 追加・PreviousSubmission) / `index.ts`(export) /
  `firebase.json`(2関数の rewrite) / `web/admin/{index.html,js/admin.js,js/cards-filter.js,css/admin.css}`。
- **検証（エミュレータ end-to-end / auth 発行込み）**：編集・やり直し・生成を **37/37**（編集の正常系＋
  invalid_address/date/time/product・not_used・401、やり直しの unused化・各項目クリア・トークン不変・履歴1件→
  受け取り者が再確定→2件、生成の batchId/generatedAt/3枚同一batch）。filterCards の batchId/LOT_NONE を実コードで
  5/5。hosting 配信DOM（ロット絞り込み・生成日時列）と API rewrite（新2関数が到達＝405）を確認。
  functions lint/build/test(20) 緑・web構文緑。
- **デプロイ（未実施）**：**web＋functions＝`firebase deploy --only hosting,functions`**。
  ★**新規HTTP関数が2つ（`adminUpdateGiftCard` / `adminResetGiftCard`）**。組織ポリシーにより firebase deploy の
  invoker 設定は失敗するため、**デプロイ後に Cloud Run コンソールで両関数を手動「パブリックアクセスを許可」に
  設定**すること（過去に他の admin 関数で対応済みの手順。認証はアプリ層 requireAuth で担保）。設定漏れがあると
  編集・やり直しが 401/403 になる。storage.rules は変更なし。

### 次段階
- 管理画面まわりはこれで一区切り。

### 0.10 追補（2026-07-09）：NE「店舗2」投入方法の確定（リファレンス調査結果の反映・実接続は審査後）
NEリファレンス調査で判明した内容を設計に反映・記録（実送信は審査通過後）。

**確定した投入方法**
- gift-system の受注投入は **受注伝票アップロードAPI `/api_v1_receiveorder_base/upload`**。
  どの店舗の受注かは **CSVの列では指定せず**、パラメータ **`receive_order_upload_pattern_id`（受注一括登録パターンID）**
  で決まる（＝これまでの「CSVに店舗列不要」設計は正しかった）。

**紛らわしい3つの番号（混同するとエラー）**
- `receive_order_shop_id` … **店舗コード**。「2:九州お取り寄せ本舗」の「2」（店舗そのものの番号）。
- `receive_order_upload_pattern_id` … **受注一括登録パターンID**。**アップロードに渡すのはこれ**。店舗コードとは別番号。
- フォーマットパターンID（汎用標準=90 等）… さらに別物。上記(b)と混同しない。

**パターンIDは決め打ちしない（NE公式回答）**
- 店舗コード「2」をそのまま `receive_order_upload_pattern_id` に入れて動く保証はない。
- **`/api_v1_receiveorder_uploadpattern/info`**（受注一括登録パターン情報取得API）を叩き、レスポンスの
  `receive_order_upload_pattern_shop_id = 2` のパターンを照合して、その `receive_order_upload_pattern_id` を
  動的に特定する（info レスポンスには id / name / shop_id が含まれる）。

**実接続時の段取り（審査後）**
1. トークン取得（既存 neApiCall がローテーション管理）
2. `/api_v1_receiveorder_uploadpattern/info` を叩く
3. レスポンスから `receive_order_upload_pattern_shop_id=2`（=NE_STORE_CODE）のパターンを見つけ、その
   `receive_order_upload_pattern_id` を取得
4. それを `NE_UPLOAD_PATTERN_ID` に設定 → `/api_v1_receiveorder_base/upload` で店舗2に投入

**設計への反映（コード）**
- `config/env.ts`：`NE_STORE_CODE`(=2 / 店舗コード＝照合キー)と `NE_UPLOAD_PATTERN_ID`(アップロードに渡すパターンID＝
  別番号・info APIで特定して設定)を、3番号の区別が分かるコメントで明記。`isNeAutoConfigured` は **uploadPatternId 必須**に
  変更（パターン未特定のまま別店舗へ誤投入しないため。storeCode 既定だけでは投入しない）。
- `ne/order.ts`：アップロードに渡すのは `receive_order_upload_pattern_id` のみ。**店舗コードは送らない**
  （`buildOrderParams` から storeCode を除去）。
- `ne/upload-pattern.ts`（新規スタブ）：`resolveUploadPatternId(shopId, deps)` を用意（info API を叩き shop_id で照合して
  パターンID を返す・見つからなければ null）。実 API 呼び出しは neApiCall 経由なので client/secret・トークンが揃うまで
  実送信は発生しない＝審査後にすぐ繋げる枠。フィールド名・パス定数も定義。
- **店舗伝票番号(token)の一意性**：token は一意な base64url で店舗2の他受注(数値ID)と衝突しない（確認済み・0.8参照）。
- **検証**：`resolveUploadPatternId` を疑似 info レスポンスで単体確認（shop_id=2→パターンID特定／該当なし→null）、
  `buildOrderParams` がパターンIDを送り店舗コードを送らないこと（4/4）。functions lint/build/test(35 passing) 緑。
- **デプロイ**：**functions のみ（＝`firebase deploy --only functions`）で反映可**。ただし内容は実接続前の
  設定/コメント/休眠スタブで**runtime挙動は不変**（自動投入は uploadPatternId 未設定で無効のまま）。急ぎでなければ
  審査後のNE実装とまとめてデプロイでもよい。**新規HTTP関数なし＝Cloud Run 手動public設定は不要**。web/storage.rules 変更なし。

### 0.9 追補（2026-07-09）：ロット絞り込みの肥大化対策（直近N件＋生成日の範囲）
ロット（生成バッチ）が増えるとプルダウンの選択肢が肥大化する懸念への軽量対策。共通化して QR一覧・印刷タブ両方に適用。
- **ロットのプルダウンは直近 `LOT_RECENT_LIMIT`(=25) 件だけ表示**（生成日の新しい順）。共通ヘルパ `lotOptionsHtml`
  に slice を入れ、超過分は「― 古いロット N 件は『生成日の範囲』で絞り込み ―」の無効オプションで案内。
  「印刷は生成直後が多い」前提で直近優先。QR一覧・印刷タブ双方に効く。
- **生成日の範囲（開始〜終了）で絞り込み**を追加（ロットが何百に増えても選択肢肥大の影響を受けずに古い分を絞れる）:
  - サーバ `adminExportUrlXlsx` に `generatedFrom`/`generatedTo`（JST・両端含む）を追加（既存の単日 generatedDate は互換で残置）。
    種別・ロット・未印刷と組合せ可。generatedAt 無しの既存カードは範囲対象外（不明ロットで拾う＝後方互換）。
  - QR一覧にも「生成日（開始〜終了）」入力を追加し、クライアント側で generatedAt(JST) 範囲フィルタ（`cardGenDateJst`）。
    既存の種別/状態/ロット/NE/期限/検索と併用可。
  - 印刷タブの「生成日」は単日→範囲(from/to)入力に置換。
- **変更ファイル**：`functions/src/http/admin-export.ts`（generatedFrom/To）/ `web/admin/index.html`（QR一覧・印刷の範囲入力）/
  `web/admin/js/admin.js`（lotOptionsHtml の直近N件＋案内・cardGenDateJst・QR一覧範囲フィルタ・印刷パラメータ）/
  `web/admin/css/admin.css`（.date-range）。**ロジック不変**（トークン照合等に影響なし）。
- **検証**：エミュレータで返却xlsxを exceljs パースし **16/16**（ロット/単日に加え範囲6-01〜6-02=5・6-02〜=2・
  〜6-01=3・該当なし0・範囲+未印刷=4・範囲+種別=5・範囲は generatedAt 無しを含めない）。配信DOMで QR一覧/印刷の
  生成日範囲入力・ロット直近25件制限（LOT_RECENT_LIMIT・古いロット案内）を確認。functions lint/build/test(35) 緑・web構文緑。
- **デプロイ（未実施）**：**web＋functions＝`firebase deploy --only hosting,functions`**。**新規HTTP関数なし**
  （既存 adminExportUrlXlsx の拡張・他はクライアント）＝**Cloud Run 手動public設定は不要**。storage.rules変更なし。

### 0.8 追補（2026-07-09）：印刷Excelのロット/生成日絞り込み＋NE「店舗2」取り込み設計
**【1】印刷用URL一覧(Excel)の対象選択にロット・生成日を追加**
- `adminExportUrlXlsx` に `batchId`（ロット）と `generatedDate`（生成日 JST）を追加。既存の `cardTypeId`／
  `unprintedOnly` と組み合わせ可能。種別・未印刷・特定ロットは Firestore の等価フィルタ（複合インデックス不要）、
  ロット「不明」(`__none__`＝batchId無しの既存カード)と生成日(JST一致)はメモリ側フィルタ。後方互換OK。
- 印刷タブに「ロット（生成）」プルダウン（種別に応じて生成される）と「生成日」入力を追加。ロット候補は
  QR一覧と共通の `lotOptionsHtml` で生成。
- **検証**：エミュレータで返却xlsxを exceljs でパースし行数確認 **9/9**（無フィルタ7／B1=3／B1+未印刷=2／
  __none__=2／生成日6-1=3／6-2=2／生成日+未印刷=2／該当なし=0／種別+ロット=2）。

**【2】NE取り込みを「店舗2」として登録する設計（実接続は審査後）**
- 要件：カタログギフト受注を NE 上で **「店舗2」**（表示「2:九州お取り寄せ本舗(makeshop)」／月次を店舗単位で集計）
  として登録する。NEでは**店舗はCSV列では指定せず**、受注登録API/一括登録時に店舗コード or 店舗に紐づく
  受注一括登録パターンIDで決まる（どちらか・パラメータ名は NE API 仕様次第＝実接続時に確定）。
- **枠を定数化（両対応・プレースホルダ）**：`config/env.ts` に `NE_STORE_CODE`（既定 "2" 仮置き）と
  `NE_UPLOAD_PATTERN_ID`（TODO・空）。`neConfig()` に `storeCode`/`uploadPatternId`。`isNeAutoConfigured` は
  「店舗コード or パターンID のいずれか」を条件に含め、店舗指定無しでの誤投入を防止（実接続前は creds/endpoint 空で
  自動投入オフ）。
- **NEマッピング（ne/order.ts）**：`NE_FIELD.storeCode`/`uploadPatternId`（TODO・要NEパラメータ名確認）を追加、
  `buildOrderParams` が店舗コード＋パターンIDを付与（不要な方は実接続時に外す）。CSVには店舗列を追加しない。
- **CSV運用の明示**：CSVファイル名を `ne-orders-shop2.csv`（サーバ Content-Disposition＋クライアント download）に。
  NEタブに「このCSVは店舗2の受注一括登録パターンで取り込むこと」の注記。csv.ts にも設計コメント。
- **店舗伝票番号(token)の一意性**：token は base64url の推測不可能な一意文字列で、店舗2の他受注（連番等の数値ID）
  とは形式・値域が異なり**衝突しない**（確認済み）。origin を明示したい場合の任意接頭辞 `NE_SLIP_PREFIX`（既定空＝
  token そのまま）＋`buildSlipNo()` を用意。
- **検証**：`buildOrderParams` にstoreCode="2"/パターンID枠が入ることを 5/5、CSVファイル名 ne-orders-shop2.csv、
  印刷タブDOM・店舗2注記を確認。functions lint/build/test(35 passing) 緑・web構文緑。
- **デプロイ（未実施）**：**web＋functions＝`firebase deploy --only hosting,functions`**。★**新規HTTP関数なし**
  （既存 adminExportUrlXlsx の拡張・NEは設定/マッピングのみ）＝**Cloud Run 手動public設定は不要**。storage.rules変更なし。

### 0.7 追補（2026-07-09）：有効期限機能（2階層・生成日起点・サーバ判定・管理者延長）
- **後方互換の方針（安全側）**：有効日数が未設定（種別に expiryDays 無し・上書きも無し）または generatedAt 不明の
  カードは**「無期限」**（期限切れにしない）。理由：全体デフォルトを入れると既存カードが遡って無効化される破壊的
  変化になるため。明示的に種別へ expiryDays を設定したものだけ期限が有効になる。
- **期限判定は共有純粋モジュール `shared/expiry.js`**（import ゼロ・環境非依存）に集約し、受け取り者確定
  （functions）・管理画面（browser）の双方が同一ロジックを使う。生成日 generatedAt + 有効日数。
  優先順位「個別上書き `expiryDaysOverride` > 種別デフォルト `expiryDays`」。`resolveExpiryDays`/`expiryMillis`/
  `expiryInfo`（expired/near/remainingDays）を提供。functions は `config/expiry.ts` 経由で参照（tsconfig include 追加）。
- **データモデル**：`giftCardTypes.expiryDays?`（デフォルト日数）、`giftCards.expiryDaysOverride?`（個別上書き）。
  有効期限日は generatedAt から算出（保存しない）。
- **受け取り者（サーバで確実にブロック）**：`receiveGetCard` は期限切れ未使用カードに `status:"expired"` を返す。
  `receiveConfirm` はトランザクション内で種別を読み期限判定し、期限切れは **410 `expired`** で確定を弾く
  （クライアント判定に依存しない）。受け取り画面に期限切れ専用ビュー（`view-expired`）＋問い合わせ先
  （`EXPIRY_CONTACT` 定数・プレースホルダ）を表示。期限内の未使用は従来どおり／二重確定防止も維持。
- **管理画面**：QR一覧を「生成日 / 有効期限」列に（期限日・期限切れ/間近を色分け表示、算出不能は「不明/無期限」）。
  状態バッジに **期限切れ（赤・強調）／期限間近（橙）** を追加。絞り込みに「期限切れ」「期限が近い(7日以内)」を追加。
  種別フォームに expiryDays 入力。詳細ビューに有効期限日・残り日数・個別上書きの表示。
- **管理者の救済（延長）**：新API **`adminSetCardExpiry`**（requireAuth・確認ダイアログ）で個別カードの期限日数を
  上書き。**期限切れカードも延長すれば再び受け取り可能**（generatedAt 起点で再計算）。空欄保存で上書き解除。
- **変更ファイル**：`shared/expiry.js`(新)・`shared/constants.js`(EXPIRY_CONTACT)・`functions/tsconfig.json`(include)・
  `functions/src/config/expiry.ts`(新)・`models/index.ts`・`http/receive.ts`(期限ブロック)・`http/admin-card.ts`
  (adminSetCardExpiry)・`index.ts`・`firebase.json`(rewrite＋**hosting predeploy が expiry.js もコピー**)・
  `web/admin/{index.html,js/admin.js,js/db.js,js/status.js,css/admin.css}`・`web/receive/{index.html,js/receive.js,css/receive.css}`。
- **検証**：`shared/expiry.js` 単体テスト **15件**（functions test 計35 passing）。エミュレータ end-to-end **16/16**
  （期限内は使える／期限切れは getCard=expired・confirm=410 で弾かれカードは未使用のまま／generatedAt無し・
  種別無期限の後方互換／管理者延長で再び使える／個別上書きが種別より優先・解除で戻る／未認証401）。
  hosting 配信で `/shared/expiry.js`・種別期限入力・期限フィルタ・生成/有効期限列・期限切れビュー・
  新API rewrite(405到達) を確認。functions lint/build 緑・web構文緑。
- **デプロイ（未実施）**：**web＋functions＝`firebase deploy --only hosting,functions`**（hosting predeploy が
  `shared/expiry.js` も web/shared へコピー）。★**新規HTTP関数 `adminSetCardExpiry`** は組織ポリシーにより
  invoker 自動設定が失敗するため、**デプロイ後に Cloud Run で手動「パブリックアクセスを許可」設定が必要**
  （未設定だと期限延長が401/403に）。※前回追加の `adminUpdateGiftCard`/`adminResetGiftCard` を本番未反映なら
  それらも同様に手動public設定が要る。storage.rules 変更なし。public設定が要るHTTP関数は計11に。

### 0.6 追補（2026-07-09）：QR一覧の罫線崩れ修正
- **原因**：`<td class="status-cell">`・`<td class="row-actions">` が **td に直接 `display:flex`** を指定していた。
  `border-collapse: collapse` のテーブルでは td を flex 化すると table-cell ボックスでなくなり、行の高さに追従せず
  罫線が短く/ずれて描画される（状態列のバッジ周辺で境界が崩れて見える正体）。加えて `.cards-table td` 全体に
  `overflow:hidden` が掛かり、バッジ（特に badge-ne-error の box-shadow）周辺をクリップして意図しない線に見せていた。
- **修正**：td は通常の table-cell のまま、flex は**内側のラッパ**へ移動。状態＝`<td><span class="status-cell">…</span></td>`、
  操作＝`<td><div class="row-actions">…</div></td>`（種別・商品タブの操作列も同様に統一）。全セルの `overflow:hidden`
  は撤去し、省略が要る列（種別・受け取り者名）だけ `td.ellip` に限定。状態列を 148px に広げバッジの折返しを抑制。
- これで各セル・各行の境界がきれいに揃い、状態バッジが罫線と干渉しない。10インチ〜PCで一覧全体が横スクロール
  なしで整って見える（min-width:720px）。
- **変更ファイル**：`web/admin/js/admin.js`（状態・操作を内側ラッパ化：QR一覧＋種別＋商品）/ `web/admin/css/admin.css`
  （全セル overflow 撤去→ellip限定・col-status幅）。**ロジック不変**。
- **検証**：td 直 flex の全廃を grep で確認、web 構文チェック緑。※罫線の見た目はブラウザ描画依存のため、
  本番反映後にスクリーンショットでご確認ください（下記ポイント）。
- **本番目視の確認ポイント**：①QR一覧の各行の下罫線・セル境界が全列でまっすぐ揃う、②「状態」列の
  未使用/使用済＋NE投入状態バッジの周りに余計な線が出ない、③行の高さ・余白が一貫、④横スクロールが出ない。
- **デプロイ（未実施）**：**web のみ＝`firebase deploy --only hosting`**（functions 変更なし・新規HTTP関数なし＝
  Cloud Run 手動public設定は不要）。

### 0.5 追補（2026-07-09）：UI見直し（重大バグ修正＋QR一覧作り直し）
- **【重大バグ修正】受け取り画面のモーダル暗転フリーズ**：`receive.css` に `[hidden] { display:none !important }`
  が無く、`.product-modal { display:flex }`（オーサーCSS）が `hidden` 属性のUA既定を上書きしていたため、
  商品詳細モーダルを閉じられず暗転で固まっていた（前回の商品詳細拡張で混入）。同ルールを追加して解消。
  これで「詳細を見る→この商品を選ぶ→モーダルが閉じ選択反映→住所入力→確定」まで通る。
  （管理画面の admin.css には元から同ルールがあり無事。）
- **受け取り画面（スマホ最優先）**：モーダルはボトムシート（`align-items:flex-end`・`max-height:92vh`・
  `overflow-y:auto`）で、ノッチ端末向けに `env(safe-area-inset-bottom)` の下余白を追加。ギャラリーは
  矢印40px・ドット・スワイプでスマホ操作可。
- **管理画面 QR一覧を作り直し**：
  - 列順を管理者目線の自然な流れに：**生成日時（ロット）→ 状態 → 種別 → 受け取り者名 → 使用日時 → memo → 操作**。
  - **横スクロール強制を解消**：旧 `min-width:1040px` がコンテンツ幅（≈960px）を超えて常時横スクロールしていた。
    一覧を要点だけに絞り `min-width:720px` に。通常PC・10インチでは横スクロールなしで収まる（極端に狭い時のみ
    `.table-scroll` が働く）。
  - **トークン列・受け取り者URL列を一覧から撤去**（最も幅を食う要素）。全文は詳細ビュー（トークン・URL＋コピー）で
    参照でき、一覧の操作列に「URLコピー」ボタンを残して即コピーも可能。受け取り者名を一覧に出し、状況が一目で
    分かるように。種別・受け取り者名は1行省略（title でツールチップ、詳細で全文）。
- **維持**：トークン照合・二重確定防止・認証・バリデーション・NE投入状態・編集/やり直し等のロジックは不変。
- **変更ファイル**：`web/receive/css/receive.css`（[hidden]・safe-area）/ `web/admin/index.html`（列・colgroup）/
  `web/admin/js/admin.js`（行の再構成・列数）/ `web/admin/css/admin.css`（列幅・min-width・省略）。
- **検証**：受け取り者確定フローのロジックは不変（既存 end-to-end で担保済み）。hosting エミュレータで、
  receive.css の `[hidden]!important` 配信・モーダルDOM健在、admin の新列順・token/URL列撤去・`min-width:720px`
  を確認。web 構文チェック緑。
- **本番目視の確認ポイント**：①スマホで「詳細を見る→この商品を選ぶ」でモーダルが閉じ、その商品が選択状態に
  なり、住所入力→確定まで進めること。②スマホでギャラリーのスワイプ/矢印切替・セット内容表示が崩れないこと。
  ③管理画面QR一覧が10インチ画面で横スクロールなしに収まり、生成→状態→種別→受け取り者名の並びで一目で
  分かること。④長いURL/トークンは一覧に出ず、詳細ビューと「URLコピー」で全文が得られること。
- **デプロイ（未実施）**：**web のみ＝`firebase deploy --only hosting`**（functions 変更なし・**新規HTTP関数なし**＝
  Cloud Run 手動public設定は不要）。反映後スマホは再読込、PCは Ctrl+Shift+R。

---

## 1. 今日（2026-07-08）到達した状態

- gift-system の主要機能（設計書 **第1〜7ステップ**）は実装済みで **本番デプロイ済み**。
  **QR生成が本番で正常動作**するところまで確認できた。
- 本番の管理画面から、以下を **動作確認済み**:
  - QRコードの一括生成
  - 受け取り者用URL一覧の確認とアクセス
  - 登録〜使用済みまでの CSV / Excel 抽出
- **グループA（管理画面の使い勝手改善）** は実装・コミット済み（コミット `f78feec`）。
  - 各タブを開いたら自動でデータ読み込みを開始（`loadTab()` で全タブ共通化）
  - データ取得中・各操作中のローディング表示（スピナー＋「読み込み中…」／0件時は明示メッセージ）
  - QR一覧に受け取り者URL（`origin + /g/<token>`）列を追加。別タブで開くリンク＋コピーボタン
  - **デプロイ（hosting）は実施予定**（下記 残タスク参照）。

### 変更ファイル（グループA）

- `web/admin/index.html` — QR一覧テーブルに「受け取り者URL」列を追加
- `web/admin/js/admin.js` — タブ自動読込（`loadTab`/`refreshTypes`）、ローディングヘルパ（`tableLoading`/`tableEmpty`/`busy`/`busyDone`）、`receiveUrl()`、コピー処理
- `web/admin/css/admin.css` — スピナー・URLセル・コピーボタンのスタイル

---

## 2. 本番稼働までに越えた主要な問題と解決（記録として重要）

本番で QR生成が動くまでに複数のインフラ／認証まわりの問題を解決した。同種の問題が再発した際の
参照用に、原因と解決策を残す。

### 2.1 ログインUIのバグ（ログイン後もフォームが残る）
- **原因**: 認証状態でのログイン画面/管理画面の出し分けが、CSS の詳細度に負けて効いていなかった。
- **解決**: `[hidden] { display: none !important; }` を追加し、`hidden` 属性が常に勝つようにした
  （`web/admin/css/admin.css`）。

### 2.2 商品編集ができない
- **原因**: 編集UI（フォームへ値を載せて更新するモード）が未実装だった。
- **解決**: 選定可能商品タブに編集機能を実装（編集時は画像を選び直したときだけ差し替え）。

### 2.3 QR生成が 401（認証エラー）
- **原因**: Cloud Run 側の **invoker が public でなかった**（Cloud Run の入口で 401 になっていた）。
- **解決**: 8つの HTTP 関数を Cloud Run コンソールで手動「パブリックアクセスを許可」に設定して解決。
  - 対象8関数: `adminGenerateGiftCards` / `adminExportUrlXlsx` / `adminExportNeCsv` /
    `adminRetryNeSubmissions` / `receiveGetCard` / `receiveConfirm` / `neCallback` / `neCallbackTest`
  - `invoker: "public"` はコード（`functions/src/http/options.ts`）でも宣言済み。
  - **認証はアプリ層の `requireAuth` で担保**している（`functions/test/guard.spec.ts` でテスト済み）。
    つまり Cloud Run 入口は public でも、admin系APIは IDトークン検証で保護される。

### 2.4 401解決後に 500（サーバエラー）
- **原因**: 関数のサービスアカウント `709387761372-compute@developer.gserviceaccount.com` に
  Firestore への権限が無かった。
- **解決**: IAM で **Cloud Datastore ユーザー（`roles/datastore.user`）** を付与して解決。

### 2.5 組織ポリシーにより `firebase deploy` 経由の invoker 設定が失敗し続けた
- **原因**: 会社の組織（`maru-sin.co.jp` / 組織ID `666430407577`）の組織ポリシーが
  `allUsers` 公開を制限しており、`firebase deploy` からの invoker 設定が通らなかった。
- **回避策**: **Cloud Run コンソールからの手動設定**でパブリックアクセスを許可した。
- **⚠️ 注意書き（今後の運用）**: **新規に HTTP 関数を追加した場合、同様に Cloud Run コンソールで
  手動でパブリック設定が必要になる可能性が高い**。デプロイ後に 401 が出たら、まず新関数の invoker が
  public になっているかを Cloud Run コンソールで確認すること。

---

## 3. 残タスク・次回やること

### 3.1 すぐやる
- **グループA のデプロイ**: `firebase deploy --only hosting`
  - hosting の predeploy が `shared/constants.js` を `web/shared/` にコピーする（`TOKEN` 参照の解決に必要）。
  - 反映後、ブラウザのハードリロード（Ctrl+Shift+R）で確認。
- **GitHub push の認証問題を解消**:
  - Git Credential Manager に別アカウント **`DELISHMALL`** の認証が残っており、
    `webka-system/gift-system` へ push できない（403 Permission denied）。
  - **`webka-system` の PAT（Personal Access Token）で認証を差し替えて push する**必要がある。
  - コミット `f78feec` が手元に **未push** で積まれている。
  - 差し替え手順の例: Windows「資格情報マネージャー」→「Windows 資格情報」の
    `git:https://github.com` を削除 → 次回 push 時に webka-system で認証。

### 3.2 グループB（受注確認ビュー）✅ 実装済み（未デプロイ）
- QR一覧の各行に「詳細」ボタンを追加。クリックで受注詳細モーダルを開く:
  - 種別・価格帯 / 状態 / 選択商品（名前・画像・NE商品コード）/ 配送先住所（氏名・郵便番号・
    都道府県・住所・建物・電話）/ 確定日時（usedAt）/ NE投入状態 / 受け取り者URL＋コピー
  - **memo は詳細モーダルからも編集・保存可能**（保存後は一覧の入力欄・キャッシュも同期）。
  - 住所・選択商品は表示のみ（編集はグループCで対応予定）。
- ステータスの **色分け表示**:
  - 未使用（青）/ 使用済（灰）＋ NE投入状態バッジ（投入済・CSV出力済=緑 / 投入中=黄 / 未投入=橙）。
  - **NE投入失敗は赤・太字・枠付きで最も目立たせる**（発送漏れ防止）。未知/未設定は安全側で「NE未投入」。
- 実装方針: 一覧・memo は既存の直Firestore、選択商品は `getProductById` で直Firestore取得。
  グループAの自動読込・ローディング表示に合わせた。ステータス表示ロジックは純粋モジュール
  `web/admin/js/status.js` に切り出し、実SSOT定数に対して Node で単体検証（13件）済み。
- **変更ファイル**: `web/admin/index.html`（詳細モーダル追加・詳細ボタン）/ `web/admin/js/admin.js`
  （詳細ビュー・状態バッジ利用・memoモーダル保存）/ `web/admin/js/status.js`（新規・状態ロジック）/
  `web/admin/js/db.js`（`getProductById` 追加）/ `web/admin/css/admin.css`（モーダル・バッジ色分け）。
- **検証**: 構文チェック / status.js の状態→バッジ・色分けロジックを実SSOTで単体検証（13/13）/
  CSSクラス整合 / hostingエミュレータで全モジュール（status.js含む）が正しいMIMEで200配信、を確認済み。
  ※ ブラウザ自動操作環境が無いため、モーダルの実クリック描画・memo保存の往復は未自動検証（要ブラウザ実機確認）。
- **デプロイ（未実施 / web のみ）**: `firebase deploy --only hosting`
  （predeploy が `shared/constants.js` を `web/shared/` にコピー。反映後 Ctrl+Shift+R で確認）。

### 3.3 グループC（管理者運用の強化）
- 管理者権限での **登録やり直し**（使用済みカードの再利用可否など）。
- 破壊的操作の **確認ダイアログ**。
- 一覧の **検索・絞り込み**。

### 3.4 NE連携の本体実装（NE審査通過後）
- `client_id` / `client_secret` 発行後、コールバックでトークンを取得・保存し、自動投入 / CSV に接続する。
- **調査結果（記録）**:
  - NE の受注取込CSVは **Shift-JIS 必須**。
  - **汎用標準パターン**で作成する。
  - **パターンIDは `/api_v1_receiveorder_uploadpattern/info` で取得**する。

### 3.5 印刷方式（確定事項）
- 印刷は **工場が「URL一覧Excel」を受け取ってQR化・印刷する方式**。
- **PDF面付けは不要**と判明済み（第7ステップで実装したPDF面付けは URL一覧Excel に差し替え済み）。

---

## 4. 参考: 本番環境の主要な識別子

| 項目 | 値 |
|---|---|
| Firebase プロジェクト | `gift-system-f33b5`（本番 hosting: `https://gift-system-f33b5.web.app`） |
| リージョン | `asia-northeast1`（東京・変更不可） |
| 関数サービスアカウント | `709387761372-compute@developer.gserviceaccount.com`（要 `roles/datastore.user`） |
| 組織 | `maru-sin.co.jp` / 組織ID `666430407577`（allUsers 公開を制限する組織ポリシーあり） |
| GitHub | `webka-system/gift-system`（push には webka-system アカウントの権限が必要） |

### public 設定が必要な HTTP 関数（11）
`adminGenerateGiftCards`, `adminExportUrlXlsx`, `adminExportNeCsv`, `adminRetryNeSubmissions`,
`receiveGetCard`, `receiveConfirm`, `neCallback`, `neCallbackTest`,
`adminUpdateGiftCard`, `adminResetGiftCard`（0.4 で追加）,
`adminSetCardExpiry`（★0.7 で追加。デプロイ後に手動public設定が必要）

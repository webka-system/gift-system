# gift-system

ソーシャルギフト（QR方式）システム。物理ギフトカードに印刷した QR コードを起点に、受け取り者が
価格帯に応じた商品を選び住所を確定すると、ネクストエンジン（NE）へ受注が渡り発送される。

- 設計書: [`docs/design.md`](docs/design.md)（開発の起点となる仕様書）
- フロント構成・技術スタックは `label-system` リポジトリに準拠。

## 構成

```
gift-system/
├─ docs/design.md          # 設計書（SSOT の仕様）
├─ shared/constants.js     # 共通定数（コレクション名・ステータス・トークン仕様）※単一情報源
├─ web/                    # Firebase Hosting（プレーン HTML/CSS/JS・ESM。ビルドツールなし）
│  ├─ admin/               # 管理画面（要ログイン / Firebase Auth）
│  ├─ receive/             # 受け取り者画面（ログイン不要 / トークンURL /g/<token>）
│  └─ shared/              # predeploy で shared/constants.js がコピーされる（.gitignore 済み）
├─ functions/              # Cloud Functions（TypeScript / 2nd gen / Node.js 22）
├─ firebase.json           # Hosting / Functions / Firestore / Storage / Emulators
├─ firestore.rules         # 本番モード・全拒否ベース（design.md 第8章）
├─ firestore.indexes.json
└─ storage.rules
```

## 技術スタック（design.md 第5章）

GCP / Firebase・Cloud Firestore（asia-northeast1）・Firebase Hosting・Firebase Storage・
Cloud Functions・Firebase Authentication（管理画面のみ）・Blaze プラン。

## セットアップ

```bash
# 1. Firebase CLI にログイン（要 reauth）
firebase login --reauth

# 2. プロジェクト確認（.firebaserc に gift-system-f33b5 を設定済み）
firebase use

# 3. Functions 依存インストール
cd functions && npm install

# 4. ローカルエミュレータ
firebase emulators:start
```

Web の本番 Firebase 設定（apiKey / appId / messagingSenderId）は、Firebase コンソール →
「プロジェクトの設定」→「マイアプリ（Web）」の実値を `web/admin/js/firebase-config.js` の
`TODO_...` プレースホルダに差し替える。

## 開発の進め方

`docs/design.md` 第9章の順序（データモデル → 管理画面 → 受け取り者画面 → NE連携 → QR/PDF）に従う。

## 注意（design.md 第8章）

- サービスアカウント鍵 JSON・API キー・`.env` は絶対にコミットしない（`.gitignore` 済み）。
- Firestore は本番モード運用。受け取り者の QR 使用は Cloud Functions 経由のみ（クライアント直アクセス禁止）。
- 受け取り者トークンは推測不可能なランダム値。GCP で予算アラートを設定する。

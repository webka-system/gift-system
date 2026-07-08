/**
 * HTTP関数（onRequest）の共通オプション
 *
 * invoker:"public" … Cloud Run の入口（invoker IAM）を allUsers 呼び出し可にする。
 *   - これを **コードで明示**することで、デプロイのたびに手動で IAM を触らなくても
 *     安定して public invoker になる（過去に頻発した「Failed to set the invoker」の根本対策）。
 *   - Cloud Run 層の認証を外す代わりに、**認証はアプリ層で必ず担保する**:
 *       admin系   → requireAuth（Firebase Auth IDトークン検証。未認証/不正トークンは 401）
 *       受け取り者 → 推測不可能なトークン照合（design.md 第8章）
 *   - Firebase Hosting の /api rewrite から関数を叩くにも public invoker が必要（設計上も妥当）。
 *
 * region … 東京（asia-northeast1）で統一（shared/constants.js REGION）。
 */

import { REGION } from "../config/constants";

export const HTTP_OPTIONS = { region: REGION, invoker: "public" as const };

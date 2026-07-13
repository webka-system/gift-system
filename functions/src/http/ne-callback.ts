/**
 * NE 認証コールバック（Redirect URI / design.md 第6章）
 *
 * ネクストエンジンのアプリ申請では、本番・テスト両方の Redirect URI（コールバックURL）が必須。
 * NE の初回トークン取得フローでは、ユーザー認証後にこの URL へ **GET** で uid と state を付けて
 * リダイレクトで戻ってくる。SSL 必須のため https（localhost 不可）。
 *   - 本番用 : https://gift-system-f33b5.web.app/api/neCallback
 *   - テスト用: https://gift-system-f33b5.web.app/api/neCallbackTest
 *
 * 【本実装】受け取った uid・state を使って /api_neauth を POST し（client_id/client_secret とともに）、
 *   access_token / refresh_token を取得して Firestore（neAuth/tokens）へ保存する（neAuthExchange）。
 *   - client_id / client_secret は **Secret Manager**（config/secrets.ts）から本関数にのみ注入される。
 *   - state は有効期限が短い（数分）。失効している場合は uid・state 取得からやり直す必要がある。
 *
 * ★prod/test の扱い: 現状は保存先を分離せず単一の neAuth/tokens を使う（テストも本番の店舗2で行う方針）。
 *   トークン交換は **prod 側でのみ実行**し、test 側は受領確認のみのスタブ（本番トークンを不意に上書きしないため）。
 *   将来 prod/test を分離する場合は、test 側に別ストア（neAuth/tokensTest 等）を渡して交換を有効化する。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { applyCors } from "./cors";
import { HTTP_OPTIONS } from "./options";
import { NE_CLIENT_ID, NE_CLIENT_SECRET } from "../config/secrets";
import { neAuthExchange } from "../ne/client";

/** 認証交換には client_id/secret（Secret Manager）が必要なので、この関数にだけ注入する。 */
const CALLBACK_OPTIONS = { ...HTTP_OPTIONS, secrets: [NE_CLIENT_ID, NE_CLIENT_SECRET] };

function pageHtml(envLabel: string, state: "idle" | "ok" | "error", detail?: string): string {
  const note = state === "ok"
    ? "認証が完了し、アクセストークンを保存しました。このウィンドウを閉じてください。"
    : state === "error"
      ? `認証に失敗しました。${detail || ""} お手数ですが、時間をおいて再度お試しください（state の有効期限切れの可能性があります）。`
      : "このURLはネクストエンジンの認証コールバック用エンドポイントです。";
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NE 認証コールバック（${envLabel}）</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:3rem auto;padding:0 1rem;line-height:1.7;color:#1a1a1a">
<h1 style="font-size:1.15rem">ネクストエンジン認証コールバック</h1>
<p>${note}</p>
<p style="color:#6b7280;font-size:.85rem">環境: ${envLabel}</p>
</body></html>`;
}

/**
 * 共通ハンドラ。uid / state を GET で受け取り、prod なら /api_neauth でトークン交換して保存する。
 * envLabel で本番/テストを区別（test は現状スタブ＝受領確認のみ）。
 */
function handleNeCallback(envLabel: "prod" | "test") {
  return onRequest(CALLBACK_OPTIONS, async (req, res) => {
    applyCors(req.headers, res, "GET, OPTIONS");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "GET") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

    const uid = typeof req.query.uid === "string" ? req.query.uid : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";

    // uid / state はログに生値を残さない（存在のみ記録）。
    logger.info("neCallback received", { env: envLabel, hasUid: !!uid, hasState: !!state });

    res.set("Content-Type", "text/html; charset=utf-8");

    // test 側は現状スタブ（本番トークンを上書きしないよう交換しない）。受領確認のみ。
    if (envLabel !== "prod") {
      res.status(200).send(pageHtml(envLabel, "idle"));
      return;
    }

    if (!uid || !state) {
      res.status(200).send(pageHtml(envLabel, "idle"));
      return;
    }

    try {
      const data = await neAuthExchange(uid, state);
      // 秘匿値・トークンはログに出さない。アカウント識別だけ記録（運用確認用）。
      logger.info("neCallback: token exchange ok", {
        env: envLabel,
        companyNeId: typeof data.company_ne_id === "string" ? data.company_ne_id : undefined,
      });
      res.status(200).send(pageHtml(envLabel, "ok"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      logger.error("neCallback: token exchange failed", { env: envLabel, message });
      res.status(200).send(pageHtml(envLabel, "error", "（詳細はサーバログを確認してください）"));
    }
  });
}

/** 本番用 Redirect URI 用エンドポイント（/api/neCallback）。 */
export const neCallback = handleNeCallback("prod");

/** テスト用 Redirect URI 用エンドポイント（/api/neCallbackTest）。 */
export const neCallbackTest = handleNeCallback("test");

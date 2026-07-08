/**
 * NE 認証コールバック（Redirect URI / design.md 第6章）
 *
 * ネクストエンジンのアプリ申請では、本番・テスト両方の Redirect URI（コールバックURL）が必須。
 * NE の初回トークン取得フローでは、ユーザー認証後にこの URL へ **GET** で uid と state を付けて
 * リダイレクトで戻ってくる。SSL 必須のため https（localhost 不可）。
 *
 * 本番用 / テスト用で 2 つの確定 URL を用意する（Hosting rewrite でパスを分ける）:
 *   - 本番用 : https://gift-system-f33b5.web.app/api/neCallback
 *   - テスト用: https://gift-system-f33b5.web.app/api/neCallbackTest
 *
 * ★ 現段階はスタブ。client_id / client_secret 発行後に、受け取った uid・state を使って
 *   NE の /api_neauth を叩き access_token / refresh_token を取得し、ne/tokens（Firestore・
 *   env で prod/test を分離）へ保存する処理をここに実装する。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { applyCors } from "./cors";
import { HTTP_OPTIONS } from "./options";

function pageHtml(envLabel: string, received: boolean): string {
  const note = received
    ? "認証情報を受信しました。ウィンドウを閉じてください。"
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
 * 共通ハンドラ。uid / state を GET で受け取り、200 を返す（現段階はスタブ）。
 * envLabel で本番/テストを区別（将来トークン保存先を分けるため）。
 */
function handleNeCallback(envLabel: "prod" | "test") {
  return onRequest(HTTP_OPTIONS, async (req, res) => {
    applyCors(req.headers, res, "GET, OPTIONS");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "GET") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

    const uid = typeof req.query.uid === "string" ? req.query.uid : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";

    // uid / state はログに生値を残さない（存在のみ記録）。
    logger.info("neCallback received", { env: envLabel, hasUid: !!uid, hasState: !!state });

    // TODO(NE): client_id/secret 発行後、ここで uid+state を使い /api_neauth を呼び、
    //   access_token / refresh_token を取得して ne/tokens（env で prod/test 分離）へ保存する。

    res.set("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(pageHtml(envLabel, !!(uid && state)));
  });
}

/** 本番用 Redirect URI 用エンドポイント（/api/neCallback）。 */
export const neCallback = handleNeCallback("prod");

/** テスト用 Redirect URI 用エンドポイント（/api/neCallbackTest）。 */
export const neCallbackTest = handleNeCallback("test");

/*
 * 株主優待クーポン 受け取り者ページ（kind=coupon 専用 / /gc/<token>）
 *
 * ★既存カタログの受け取り者ページ（receive.js）とは完全に別物。カタログには一切依存しない。
 * ★注文（発行）の生命線ページなので、/shared の外部モジュールに依存しない（自己完結。8.6 の教訓）。
 *
 * フロー: トークン照合（receiveGetCoupon）→
 *   - 発行済み: 保存済みコードを即表示（APIを叩かない）。
 *   - 未発行  : receiveClaimCoupon で都度発行（発行中はローディング）→ コード表示。
 *   - 期限切れ / 失敗 / 無効 は状態別表示。失敗はリトライ可能。
 */

const $ = (sel, root = document) => root.querySelector(sel);

// 表示を切り替えるビュー一覧。
const VIEWS = ["view-loading", "view-issuing", "view-invalid", "view-expired", "view-failed", "view-coupon"];
function show(id) {
  for (const v of VIEWS) { const el = $("#" + v); if (el) el.hidden = v !== id; }
}

/** URL からトークンを取り出す（/gc/<token>、確認用に ?token= も許容）。 */
function tokenFromUrl() {
  const q = new URLSearchParams(location.search).get("token");
  if (q) return q.trim();
  const m = location.pathname.match(/\/gc\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

const token = tokenFromUrl();
let ecUrl = "https://www.otoriyose.site/";
// 会員登録の専用ページ（①のステップのリンク先。ECトップとは別URL・固定）。
const REGISTER_URL = "https://www.otoriyose.site/html/page80.html";
let waitTries = 0;
const MAX_WAIT_TRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 種別名・割引・有効期限・ECリンクを画面に反映（どの状態でも共通のメタ情報）。 */
function applyMeta(data) {
  if (data.ecUrl) ecUrl = data.ecUrl;
  const link = $("#ec-link"); if (link) link.href = ecUrl;                 // ②③ 用: ECサイトトップ
  const link1 = $("#ec-link-1"); if (link1) link1.href = REGISTER_URL;     // ① 用: 会員登録ページ（専用URL）
  $("#coupon-name").textContent = data.couponType?.name || "";
  $("#coupon-discount").textContent = data.couponType?.discountText || "";
  $("#coupon-expiry").textContent = data.expiryText ? `有効期限：${data.expiryText}まで` : "";
}

function showCoupon(code) {
  $("#coupon-code").textContent = code || "";
  show("view-coupon");
}

/** 取得済みの状態から表示を振り分ける。 */
async function route(data) {
  switch (data.status) {
    case "issued": showCoupon(data.couponCode); return;
    case "expired": show("view-expired"); return;
    case "ready": await claim(); return;
    case "issuing": await waitAndRefetch(); return;
    default: show("view-invalid");
  }
}

/** 別リクエストが発行処理中（issuing）のとき、少し待って再取得→再振り分け。数回で打ち切り。 */
async function waitAndRefetch() {
  if (waitTries++ >= MAX_WAIT_TRIES) { show("view-failed"); return; }
  show("view-issuing");
  await sleep(1500);
  try {
    const res = await fetch(`/api/receiveGetCoupon?token=${encodeURIComponent(token)}`);
    if (res.status === 404) { show("view-invalid"); return; }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) { show("view-failed"); return; }
    applyMeta(data);
    await route(data);
  } catch (_) {
    show("view-failed");
  }
}

/** 都度発行（未発行を検証→MakeShop発行→issued 確定）。 */
async function claim() {
  show("view-issuing");
  let data;
  try {
    const res = await fetch("/api/receiveClaimCoupon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.status === 404) { show("view-invalid"); return; }
    data = await res.json().catch(() => ({}));
    if (!data.ok) { show("view-failed"); return; }
  } catch (_) {
    show("view-failed");
    return;
  }
  switch (data.status) {
    case "issued": showCoupon(data.couponCode); return;
    case "expired": show("view-expired"); return;
    case "issuing": await waitAndRefetch(); return;
    default: show("view-failed"); // failed 等
  }
}

async function init() {
  waitTries = 0;
  if (!token) { show("view-invalid"); return; }
  show("view-loading");
  let data;
  try {
    const res = await fetch(`/api/receiveGetCoupon?token=${encodeURIComponent(token)}`);
    if (res.status === 404) { show("view-invalid"); return; }
    data = await res.json().catch(() => ({}));
    if (!data.ok) { show("view-invalid"); return; }
  } catch (_) {
    show("view-failed");
    return;
  }
  applyMeta(data);
  await route(data);
}

/** コピー成否のフィードバック（数秒で消える）。 */
function feedback(msg = "コピーしました", isErr = false) {
  const el = $("#copy-feedback");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2200);
}

$("#copy-btn")?.addEventListener("click", async () => {
  const code = $("#coupon-code").textContent || "";
  try {
    await navigator.clipboard.writeText(code);
    feedback("コピーしました");
  } catch (_) {
    feedback("コピーできませんでした。コードを長押しで選択してください。", true);
  }
});

$("#retry-btn")?.addEventListener("click", () => { init(); });

init();

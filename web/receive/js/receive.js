/*
 * 受け取り者画面コントローラ（design.md 4.2）
 *
 * ログイン不要・トークンURL /g/<token> で着地する。すべての読み書きは Cloud Functions 経由
 * （クライアント直Firestoreアクセスは禁止 / design.md 第8章）。Firebase SDK は読み込まない。
 *
 * フロー: トークン照合 → 商品ラインナップ表示 → 商品1つ選択 → 住所入力 → 確定 → 完了画面。
 * 使用済みトークンは「使用済み」表示（二重利用防止）。
 */

import { DELIVERY } from "/shared/constants.js";

const $ = (sel, root = document) => root.querySelector(sel);

/** HTMLエスケープ（商品名・説明の表示時XSS対策）。 */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// 全角カナ（カタカナブロック＋長音・中黒・全角/半角スペース）。氏名カナの形式チェック用。
const KANA_RE = /^[゠-ヿ　\s]+$/;
// 簡易メール形式（前後空白なし・@・ドメインにドット）。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Date → "YYYY-MM-DD"（ローカル日付）。 */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 配達希望日の選択可能範囲（今日基準 / 確定日相当）。min=+MIN_DAYS, max=+MAX_MONTHS。 */
function deliveryDateBounds() {
  const min = new Date(); min.setDate(min.getDate() + DELIVERY.MIN_DAYS);
  const max = new Date(); max.setMonth(max.getMonth() + DELIVERY.MAX_MONTHS);
  return { min: ymd(min), max: ymd(max) };
}

/** 配達希望のUI（時間帯セレクト・日付範囲）を定数から組み立てる。 */
function setupDeliveryControls() {
  const timeSel = $('select[name="deliveryTime"]');
  if (timeSel) {
    for (const slot of DELIVERY.TIME_SLOTS) {
      const opt = document.createElement("option");
      opt.value = slot;
      opt.textContent = slot;
      timeSel.appendChild(opt);
    }
  }
  const dateInput = $('input[name="deliveryDate"]');
  if (dateInput) {
    const { min, max } = deliveryDateBounds();
    dateInput.min = min;
    dateInput.max = max;
  }
}

/** 表示するビューを1つだけ出す。 */
function show(id) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== id;
}

/**
 * URL からトークンを取り出す。
 *   - 本番/エミュ: /g/<token>（hosting rewrite → /receive/index.html）。
 *   - 直開き確認用: ?token=<token> も許容。
 */
function tokenFromUrl() {
  const q = new URLSearchParams(location.search).get("token");
  if (q) return q.trim();
  const m = location.pathname.match(/\/g\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

const token = tokenFromUrl();
let selectedProductId = null;

// 配達希望のUI（時間帯・日付範囲）を先に組み立てる。
setupDeliveryControls();

// 起動: トークンでカードを引く。
init();

async function init() {
  if (!token) { show("view-invalid"); return; }
  try {
    const res = await fetch(`/api/receiveGetCard?token=${encodeURIComponent(token)}`);
    if (res.status === 404) { show("view-invalid"); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { show("view-invalid"); return; }

    if (data.status === "used") { show("view-used"); return; }

    renderSelection(data);
    show("view-select");
  } catch (_) {
    show("view-invalid");
  }
}

function renderSelection(data) {
  if (data.cardType?.name) $("#card-type-name").textContent = data.cardType.name;

  const list = $("#product-list");
  const products = Array.isArray(data.products) ? data.products : [];
  if (products.length === 0) {
    list.innerHTML = `<p class="muted">現在お選びいただける商品がありません。お手数ですがお問い合わせください。</p>`;
    return;
  }
  list.innerHTML = products.map((p) => `
    <label class="product-card">
      <input type="radio" name="product" value="${esc(p.id)}" />
      <div class="product-media">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy" />` : ""}</div>
      <div class="product-info">
        <div class="product-name">${esc(p.name)}</div>
        <div class="product-desc">${esc(p.description)}</div>
      </div>
    </label>
  `).join("");

  list.addEventListener("change", (e) => {
    if (e.target.name !== "product") return;
    selectedProductId = e.target.value;
    for (const card of list.querySelectorAll(".product-card")) {
      card.classList.toggle("selected", card.contains(e.target) && e.target.checked);
    }
  });
}

$("#confirm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#form-error");
  err.hidden = true;

  if (!selectedProductId) {
    err.textContent = "商品を1つ選択してください。";
    err.hidden = false;
    return;
  }

  const fd = new FormData(e.target);
  const g = (k) => (fd.get(k) || "").trim();
  const shippingAddress = {
    name: g("name"),
    nameKana: g("nameKana"),
    postalCode: g("postalCode"),
    prefecture: g("prefecture"),
    address: g("address"),
    building: g("building"),
    phone: g("phone"),
  };
  const email = g("email");
  const emailConfirm = g("emailConfirm");
  const deliveryDate = g("deliveryDate");
  const deliveryTime = g("deliveryTime");

  // --- クライアント側の事前チェック（サーバでも同じ内容を検証する）---
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  if (!shippingAddress.name || !shippingAddress.postalCode || !shippingAddress.prefecture
      || !shippingAddress.address || !shippingAddress.phone) {
    return fail("お届け先の必須項目をご確認ください。");
  }
  if (!KANA_RE.test(shippingAddress.nameKana)) {
    return fail("お名前（カナ）は全角カナで入力してください。");
  }
  if (!EMAIL_RE.test(email)) {
    return fail("メールアドレスの形式をご確認ください。");
  }
  if (email !== emailConfirm) {
    return fail("確認用メールアドレスが一致しません。");
  }
  if (deliveryDate) {
    const { min, max } = deliveryDateBounds();
    if (deliveryDate < min || deliveryDate > max) {
      return fail("配達希望日は指定できる範囲外です。選び直してください。");
    }
  }
  if (deliveryTime && !DELIVERY.TIME_SLOTS.includes(deliveryTime)) {
    return fail("配達希望時間帯の指定が正しくありません。");
  }

  const btn = $("#confirm-btn");
  btn.disabled = true;
  btn.textContent = "送信中…";
  try {
    const res = await fetch("/api/receiveConfirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token, selectedProductId, shippingAddress,
        email, emailConfirm, deliveryDate, deliveryTime,
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) { show("view-done"); return; }

    // 同時確定・再確定は「使用済み」表示に倒す（二重利用防止）。
    if (res.status === 409) { show("view-used"); return; }
    if (res.status === 404) { show("view-invalid"); return; }

    // それ以外（入力不備・商品不正・通信）は同画面でエラー表示。
    const byCode = {
      invalid_address: "お届け先の入力に不足があります。必須項目・カナをご確認ください。",
      invalid_email: "メールアドレスの形式・確認用の一致をご確認ください。",
      invalid_delivery_date: "配達希望日は指定できる範囲外です。選び直してください。",
      invalid_delivery_time: "配達希望時間帯の指定が正しくありません。",
      invalid_product: "選択された商品が無効です。お手数ですが選び直してください。",
    };
    err.textContent = byCode[data.code] || "送信に失敗しました。時間をおいて再度お試しください。";
    err.hidden = false;
  } catch (_) {
    err.textContent = "通信に失敗しました。接続をご確認ください。";
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "この内容で確定する";
  }
});

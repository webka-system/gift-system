/*
 * 受け取り者画面コントローラ（design.md 4.2）
 *
 * ログイン不要・トークンURL /g/<token> で着地する。すべての読み書きは Cloud Functions 経由
 * （クライアント直Firestoreアクセスは禁止 / design.md 第8章）。Firebase SDK は読み込まない。
 *
 * フロー: トークン照合 → 商品ラインナップ表示 → 商品1つ選択 → 住所入力 → 確定 → 完了画面。
 * 使用済みトークンは「使用済み」表示（二重利用防止）。
 */

import { DELIVERY, PREFECTURES } from "/shared/constants.js";

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

/** 都道府県プルダウンを47都道府県で埋める（先頭の「選択してください」は残す）。 */
function setupPrefectures() {
  const sel = $('select[name="prefecture"]');
  if (!sel) return;
  for (const pref of PREFECTURES) {
    const opt = document.createElement("option");
    opt.value = pref;
    opt.textContent = pref;
    sel.appendChild(opt);
  }
}

/**
 * 郵便番号→住所の自動入力（zipcloud 郵便番号検索API / CORS許可・クライアント直fetch）。
 * 7桁そろったら検索し、都道府県プルダウンと住所欄（市区町村＋町域）を補助的に埋める。
 * 補完後もユーザーが手で修正できる（固定はしない）。ハイフンや全角は許容して数字だけ見る。
 */
async function lookupPostalCode() {
  const zipInput = $('input[name="postalCode"]');
  const status = $("#zip-status");
  if (!zipInput) return;
  const digits = (zipInput.value || "").replace(/[^0-9]/g, "");
  if (digits.length !== 7) return; // 7桁そろうまで何もしない。
  if (status) status.textContent = "住所を検索中…";
  try {
    const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${digits}`);
    const data = await res.json().catch(() => ({}));
    const hit = Array.isArray(data.results) ? data.results[0] : null;
    if (!hit) {
      if (status) status.textContent = "該当する住所が見つかりませんでした。手入力してください。";
      return;
    }
    // 都道府県プルダウン（address1 は PREFECTURES と一致）。
    const prefSel = $('select[name="prefecture"]');
    if (prefSel && hit.address1) prefSel.value = hit.address1;
    // 住所欄は市区町村＋町域を補完（番地・建物は利用者が続けて入力）。
    const addrInput = $('input[name="address"]');
    if (addrInput) addrInput.value = `${hit.address2 || ""}${hit.address3 || ""}`;
    if (status) status.textContent = "住所を自動入力しました。番地・建物名を続けてご入力ください。";
  } catch (_) {
    if (status) status.textContent = "住所の自動入力に失敗しました。手入力してください。";
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

// フォームの補助UI（都道府県プルダウン・配達希望）と商品詳細モーダルを先に組み立てる。
setupPrefectures();
setupDeliveryControls();
setupProductModal();

// 郵便番号が7桁そろったら住所を自動入力（入力途中・確定どちらでも拾う）。
const zipInput = $('input[name="postalCode"]');
if (zipInput) {
  zipInput.addEventListener("input", lookupPostalCode);
  zipInput.addEventListener("change", lookupPostalCode);
}

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

// 商品データを id で引けるように保持（詳細ビュー用）。
let productsById = {};

function renderSelection(data) {
  if (data.cardType?.name) $("#card-type-name").textContent = data.cardType.name;

  const list = $("#product-list");
  const products = Array.isArray(data.products) ? data.products : [];
  productsById = {};
  for (const p of products) productsById[p.id] = p;
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
        <button type="button" class="detail-link" data-id="${esc(p.id)}">詳細を見る</button>
      </div>
    </label>
  `).join("");

  // 選択（ラジオ）: 既存挙動を維持。カードのハイライトを更新。
  list.addEventListener("change", (e) => {
    if (e.target.name !== "product") return;
    selectedProductId = e.target.value;
    for (const card of list.querySelectorAll(".product-card")) {
      card.classList.toggle("selected", card.contains(e.target) && e.target.checked);
    }
  });

  // 「詳細を見る」: 商品詳細モーダルを開く（ラジオは選択しない）。
  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".detail-link");
    if (!btn) return;
    e.preventDefault();   // ラベル経由でラジオが選択されないように。
    e.stopPropagation();
    openProductModal(btn.dataset.id);
  });
}

// ============================================================
// 商品詳細モーダル（画像ギャラリー・セット内容・説明。選ぶときの材料）
// ============================================================
let pmProductId = null;
let pmImages = [];
let pmIndex = 0;

/** セット内容（改行区切り）を「・」付きリストで。空なら空文字。 */
function setContentsHtml(text) {
  const items = String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return "";
  return `<h3>セット内容</h3><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

/** 現在の pmIndex の画像＋矢印＋ドットを描画する。 */
function renderPmGallery() {
  const g = $("#pm-gallery");
  if (!pmImages.length) { g.innerHTML = `<div class="pm-noimg">画像はありません</div>`; return; }
  const many = pmImages.length > 1;
  const arrows = many
    ? `<button type="button" class="pm-arrow pm-prev" aria-label="前の画像">‹</button>
       <button type="button" class="pm-arrow pm-next" aria-label="次の画像">›</button>` : "";
  const dots = many
    ? `<div class="pm-dots">${pmImages.map((_u, i) => `<span class="pm-dot${i === pmIndex ? " active" : ""}"></span>`).join("")}</div>` : "";
  g.innerHTML = `
    <div class="pm-stage">
      <img class="pm-img" src="${esc(pmImages[pmIndex])}" alt="" />
      ${arrows}
    </div>
    ${dots}`;
}

/** i 番目の画像へ（範囲を巡回）。 */
function pmShow(i) {
  const n = pmImages.length;
  if (!n) return;
  pmIndex = (i + n) % n;
  renderPmGallery();
}

/** 商品詳細モーダルを開く。 */
function openProductModal(id) {
  const p = productsById[id];
  if (!p) return;
  pmProductId = id;
  pmImages = [p.imageUrl, ...(Array.isArray(p.additionalImages) ? p.additionalImages : [])].filter(Boolean);
  pmIndex = 0;
  $("#pm-name").textContent = p.name || "";
  $("#pm-set").innerHTML = setContentsHtml(p.setContents);
  $("#pm-desc").textContent = p.description || "";
  renderPmGallery();
  $("#product-modal").hidden = false;
}

/** 商品詳細モーダルを閉じる。 */
function closeProductModal() {
  $("#product-modal").hidden = true;
  pmProductId = null;
}

/** 詳細モーダルの「この商品を選ぶ」: 対応するラジオを選択して閉じる（既存の選択挙動を流用）。 */
function selectFromModal() {
  const radios = [...document.querySelectorAll('input[name="product"]')];
  const radio = radios.find((r) => r.value === pmProductId);
  if (radio) {
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  }
  closeProductModal();
}

/** 商品詳細モーダルのイベントを一度だけ配線する（画像切替・スワイプ・選択・閉じる）。 */
function setupProductModal() {
  const modal = $("#product-modal");
  const gallery = $("#pm-gallery");
  if (!modal || !gallery) return;

  // 矢印・ドットでの切替。
  gallery.addEventListener("click", (e) => {
    if (e.target.closest(".pm-next")) pmShow(pmIndex + 1);
    else if (e.target.closest(".pm-prev")) pmShow(pmIndex - 1);
    else if (e.target.classList.contains("pm-dot")) {
      const dots = [...gallery.querySelectorAll(".pm-dot")];
      pmShow(dots.indexOf(e.target));
    }
  });

  // スワイプ（左右）での切替。
  let startX = null;
  gallery.addEventListener("touchstart", (e) => { startX = e.touches[0]?.clientX ?? null; }, { passive: true });
  gallery.addEventListener("touchend", (e) => {
    if (startX == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
    if (Math.abs(dx) > 40) pmShow(pmIndex + (dx < 0 ? 1 : -1));
    startX = null;
  }, { passive: true });

  $("#pm-select").addEventListener("click", selectFromModal);
  $("#pm-close").addEventListener("click", closeProductModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeProductModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeProductModal();
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
        email, deliveryDate, deliveryTime,
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
      invalid_email: "メールアドレスの形式をご確認ください。",
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

/*
 * 受け取り者画面コントローラ（design.md 4.2）
 *
 * ログイン不要・トークンURL /g/<token> で着地する。すべての読み書きは Cloud Functions 経由
 * （クライアント直Firestoreアクセスは禁止 / design.md 第8章）。Firebase SDK は読み込まない。
 *
 * フロー: トークン照合 → 商品ラインナップ表示 → 商品1つ選択 → 住所入力 → 確定 → 完了画面。
 * 使用済みトークンは「使用済み」表示（二重利用防止）。
 */

import { DELIVERY, PREFECTURES, EXPIRY_CONTACT } from "/shared/constants.js";

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

/** "YYYY-MM-DD" → "M月D日"（案内・エラー文の日本語表記）。 */
function ymdToJp(s) {
  const p = String(s).split("-");
  return p.length === 3 ? `${Number(p[1])}月${Number(p[2])}日` : String(s);
}

/**
 * 配達希望日の選択可能範囲（今日基準 / 確定日相当。min=+MIN_DAYS, max=+MAX_MONTHS）。
 * ★受け取り者ページ（注文の生命線）を **外部sharedファイルの配信有無に依存させない**ため、
 *   ここに自己完結で持つ（万一 shared 資産の配信が欠けても注文フローが白画面で落ちない）。
 *   同一ロジックの単体テストは shared/delivery.js（functions/test/delivery.spec.ts）で担保。
 */
function deliveryDateBounds() {
  const min = new Date(); min.setDate(min.getDate() + DELIVERY.MIN_DAYS);
  const max = new Date(); max.setMonth(max.getMonth() + DELIVERY.MAX_MONTHS);
  return { min: ymd(min), max: ymd(max) };
}

// 配達希望日が範囲外のときに立てるフラグ（確定ボタンの無効化に使う）。
let deliveryDateInvalid = false;

/**
 * 配達希望日の即時検証（iOS Safari で min/max が無視される問題の保険）。
 * 変更のたびに範囲（確定日+MIN_DAYS 〜 +MAX_MONTHS）を検証し、範囲外ならその場で
 * 具体的な選択可能期間を示すエラー＋赤枠＋確定ボタン無効化。範囲内/未入力なら案内文に戻す。
 * サーバ(receiveConfirm)の検証が最終防衛線であることは変えない（これは体験改善のための前段）。
 */
function validateDeliveryDate() {
  const input = $('input[name="deliveryDate"]');
  const note = $("#delivery-date-note");
  const btn = $("#confirm-btn");
  if (!input) return;
  const { min, max } = deliveryDateBounds();
  const rangeJp = `${ymdToJp(min)}〜${ymdToJp(max)}`;
  const v = (input.value || "").trim();

  // 未入力（任意）または範囲内 → 有効。案内文（選択可能期間）を表示。
  if (!v || (v >= min && v <= max)) {
    deliveryDateInvalid = false;
    input.classList.remove("invalid");
    if (note) { note.className = "field-note"; note.textContent = `📅 ${rangeJp} の間でお選びいただけます`; }
    if (btn) btn.disabled = false;
    return;
  }
  // 範囲外 → その場でエラー表示＋赤枠＋確定を無効化。
  deliveryDateInvalid = true;
  input.classList.add("invalid");
  if (note) { note.className = "field-note warn"; note.textContent = `配達希望日は ${rangeJp} の間で選択してください。`; }
  if (btn) btn.disabled = true;
}

/** 配達希望のUI（時間帯セレクト・日付範囲・選択可能期間の案内・即時検証）を定数から組み立てる。 */
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
    dateInput.min = min; // PC(Chrome等)ではネイティブに効く。
    dateInput.max = max;
    // iOS Safari は上記 min/max を無視するため、選択のたびに JS で範囲検証する（保険）。
    dateInput.addEventListener("change", validateDeliveryDate);
    dateInput.addEventListener("input", validateDeliveryDate);
    // 選択可能期間を選ぶ前から常時案内（初期表示）。
    validateDeliveryDate();
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
  const setNote = (cls, msg) => { if (status) { status.className = `field-note ${cls}`; status.textContent = msg; } };
  if (digits.length !== 7) return; // 7桁そろうまで何もしない。
  setNote("searching", "住所を検索中…");
  try {
    const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${digits}`);
    const data = await res.json().catch(() => ({}));
    const hit = Array.isArray(data.results) ? data.results[0] : null;
    if (!hit) {
      setNote("warn", "該当する住所が見つかりませんでした。手入力してください。");
      return;
    }
    // 都道府県プルダウン（address1 は PREFECTURES と一致）。
    const prefSel = $('select[name="prefecture"]');
    if (prefSel && hit.address1) { prefSel.value = hit.address1; prefSel.classList.remove("invalid"); }
    // 住所欄は市区町村＋町域を補完（番地・建物は利用者が続けて入力）。
    const addrInput = $('input[name="address"]');
    if (addrInput) { addrInput.value = `${hit.address2 || ""}${hit.address3 || ""}`; addrInput.classList.remove("invalid"); }
    setNote("ok", "住所を自動入力しました。番地・建物名を続けてご入力ください。");
  } catch (_) {
    setNote("warn", "住所の自動入力に失敗しました。手入力してください。");
  }
}

/** 入力エラーの赤枠をすべて解除（確定を押し直す前にリセット）。 */
function clearInvalidFields() {
  for (const el of document.querySelectorAll(".address-form .invalid")) el.classList.remove("invalid");
  const list = document.querySelector("#product-list");
  if (list) list.classList.remove("invalid");
}

/** 指定の name の欄を赤枠にし、最初の欄へフォーカス＆スクロール（どこを直せばよいか示す）。 */
function markInvalidFields(names) {
  let first = null;
  for (const n of names) {
    const el = document.querySelector(`.address-form [name="${n}"]`);
    if (el) { el.classList.add("invalid"); if (!first) first = el; }
  }
  if (first) {
    try { first.focus({ preventScroll: true }); } catch (_) { /* noop */ }
    first.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

/** 表示するビューを1つだけ出す。 */
function show(id) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== id;
}

/** 期限切れ画面の文言・問い合わせ先を定数から描画（プレースホルダは後で差し替え可能）。 */
function renderExpiredView() {
  const c = EXPIRY_CONTACT || {};
  $("#expired-heading").textContent = c.heading || "受け取り期限が過ぎています";
  $("#expired-body").textContent = c.body || "";
  const lines = [];
  if (c.note) lines.push(`<p>${esc(c.note)}</p>`);
  const contact = [];
  if (c.name) contact.push(esc(c.name));
  if (c.email) contact.push(`メール: <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`);
  if (c.phone) contact.push(`電話: ${esc(c.phone)}`);
  if (contact.length) lines.push(`<p class="muted small">${contact.join("　/　")}</p>`);
  $("#expired-contact").innerHTML = lines.join("");
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
    if (data.status === "expired") { renderExpiredView(); show("view-expired"); return; }

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

// 入力を直したら、その欄の赤枠を即解除（フィードバック）。
// ただし配達希望日は専用ハンドラ(validateDeliveryDate)が赤枠/確定無効を管理するため、ここでは触らない。
$("#confirm-form").addEventListener("input", (e) => {
  if (e.target.name === "deliveryDate") return;
  e.target.classList && e.target.classList.remove("invalid");
});
$("#confirm-form").addEventListener("change", (e) => {
  if (e.target.name === "deliveryDate") return;
  e.target.classList && e.target.classList.remove("invalid");
});

$("#confirm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#form-error");
  err.hidden = true;
  clearInvalidFields();

  if (!selectedProductId) {
    err.textContent = "商品を1つ選んでください。";
    err.hidden = false;
    const list = $("#product-list");
    if (list) { list.classList.add("invalid"); list.scrollIntoView({ block: "center", behavior: "smooth" }); }
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

  // --- クライアント側の事前チェック（サーバでも同じ内容を検証する）。エラー時は該当欄を赤枠で示す ---
  const fail = (msg, fields = []) => { err.textContent = msg; err.hidden = false; markInvalidFields(fields); };
  // 必須（住所ブロック）の未入力欄を特定して示す。
  const missing = ["name", "postalCode", "prefecture", "address", "phone"].filter((k) => !shippingAddress[k]);
  if (missing.length) {
    return fail("未入力の必須項目があります。赤枠の欄をご入力ください。", missing);
  }
  if (!KANA_RE.test(shippingAddress.nameKana)) {
    return fail("お名前（カナ）は全角カナでご入力ください。", ["nameKana"]);
  }
  if (!EMAIL_RE.test(email)) {
    return fail("メールアドレスの形式をご確認ください。", ["email"]);
  }
  if (deliveryDate) {
    const { min, max } = deliveryDateBounds();
    if (deliveryDate < min || deliveryDate > max) {
      validateDeliveryDate(); // 案内文もエラー表示に同期。
      return fail(`配達希望日は ${ymdToJp(min)}〜${ymdToJp(max)} の間で選択してください。`, ["deliveryDate"]);
    }
  }
  if (deliveryTime && !DELIVERY.TIME_SLOTS.includes(deliveryTime)) {
    return fail("配達希望時間帯の指定が正しくありません。", ["deliveryTime"]);
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
    // 有効期限切れは専用画面へ（サーバが確定を弾いた）。
    if (res.status === 410 || data.code === "expired") { renderExpiredView(); show("view-expired"); return; }

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
    // 配達希望日が範囲外のままなら確定は無効を維持（誤送信防止）。
    btn.disabled = deliveryDateInvalid;
    btn.textContent = "この内容で確定する";
  }
});

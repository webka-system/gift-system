/*
 * 管理画面 web/admin コントローラ（design.md 4.1）
 *
 * 画面構成（ログイン必須）:
 *   - カード種別: giftCardTypes の一覧・登録・編集・有効/無効（クライアント直Firestore）
 *   - 選定可能商品: 種別ごとの商品 CRUD＋画像アップロード（親子構造 / 直Firestore＋Storage）
 *   - QR生成: 種別指定で任意個数を一括生成（Cloud Functions /api/adminGenerateGiftCards）
 *   - QR一覧: ステータス確認・memo入力（一覧は直Firestore・生成/確定は Functions）
 *
 * ハイブリッド構成の境界:
 *   種別/商品 CRUD と一覧 = 直Firestore（ログイン必須ルールで保護）。
 *   トークン生成を伴う一括生成 = Functions（サーバ側でのみトークン発行）。
 */

import { onAuth, login, logout, idToken, loginErrorMessage } from "./auth.js";
import {
  listCardTypes, createCardType, updateCardType, setCardTypeActive,
  listProductsByType, createProduct, updateProduct, deleteProduct,
  listCards, updateCardMemo, CARD_STATUS,
} from "./db.js";
import { uploadProductImage } from "./storage.js";

// ===== 小さなユーティリティ =====
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** HTMLエスケープ（管理者入力の表示時XSS対策）。 */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** 価格を「¥30,000」表記に。 */
function yen(n) {
  return typeof n === "number" ? `¥${n.toLocaleString("ja-JP")}` : "";
}

/** Firestore Timestamp → 日本語日時。 */
function fmtDate(ts) {
  if (!ts) return "";
  const d = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  return d.toLocaleString("ja-JP");
}

/** 画面上の一時メッセージ表示。 */
function flash(msg, kind = "info") {
  const el = $("#flash");
  el.textContent = msg;
  el.className = `flash flash-${kind}`;
  el.hidden = false;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { el.hidden = true; }, 4000);
}

// 種別のキャッシュ（商品・QR画面のセレクタ描画に使う）。
let cardTypesCache = [];

/**
 * admin系 API（/api/admin*）の共通 fetch。ログイン中ユーザーの IDトークンを Authorization に付与する。
 * トークンが取得できない（＝ログイン切れ）ときは "Bearer null" を送らず、明確なエラーで止める。
 * これにより「トークン未付与による 401」を早期・明確に検知できる。
 */
async function authorizedFetch(url, options = {}) {
  const token = await idToken();
  if (!token) {
    throw new Error("ログインの有効期限が切れています。ページを再読み込みして再度ログインしてください。");
  }
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
}

// ============================================================
// 認証ゲート
// ============================================================
onAuth((user) => {
  if (user) {
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    $("#user-email").textContent = user.email || "";
    bootApp();
  } else {
    $("#app-view").hidden = true;
    $("#login-view").hidden = false;
  }
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").hidden = true;
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  try {
    await login(email, password);
  } catch (err) {
    $("#login-error").textContent = loginErrorMessage(err?.code);
    $("#login-error").hidden = false;
  }
});

$("#logout-btn").addEventListener("click", () => logout());

// タブ切替。
$$(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-${tab}`; });
    if (tab === "products" || tab === "generate" || tab === "cards" || tab === "print") refreshTypeSelectors();
  });
});

// アプリ初期化（ログイン後）。
let booted = false;
async function bootApp() {
  if (booted) return;
  booted = true;
  wireForms();
  await renderCardTypes();
}

// ============================================================
// カード種別
// ============================================================
async function renderCardTypes() {
  cardTypesCache = await listCardTypes();
  const tbody = $("#types-tbody");
  tbody.innerHTML = "";
  if (cardTypesCache.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">まだ種別がありません。下のフォームから登録してください。</td></tr>`;
    return;
  }
  for (const t of cardTypesCache) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(t.name)}</td>
      <td>${yen(t.price)}</td>
      <td>${esc(t.cardProductCode)}</td>
      <td>${t.active ? "有効" : "<span class='muted'>無効</span>"}</td>
      <td class="row-actions">
        <button data-act="toggle" data-id="${t.id}">${t.active ? "無効化" : "有効化"}</button>
        <button data-act="edit" data-id="${t.id}">編集</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

$("#types-tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const t = cardTypesCache.find((x) => x.id === btn.dataset.id);
  if (!t) return;
  if (btn.dataset.act === "toggle") {
    await setCardTypeActive(t.id, !t.active);
    flash(`「${t.name}」を${t.active ? "無効化" : "有効化"}しました。`);
    await renderCardTypes();
  } else if (btn.dataset.act === "edit") {
    // 簡易編集：フォームに値を載せて更新モードにする。
    $("#type-id").value = t.id;
    $("#type-name").value = t.name;
    $("#type-price").value = t.price;
    $("#type-code").value = t.cardProductCode;
    $("#type-submit").textContent = "種別を更新";
    $("#type-name").focus();
  }
});

function wireForms() {
  // 種別フォーム（新規/更新兼用）。
  $("#type-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#type-id").value;
    const data = {
      name: $("#type-name").value.trim(),
      price: Number($("#type-price").value),
      cardProductCode: $("#type-code").value.trim(),
    };
    if (!data.name || !Number.isFinite(data.price)) {
      flash("種別名と価格は必須です。", "error");
      return;
    }
    if (id) {
      await updateCardType(id, data);
      flash("種別を更新しました。");
    } else {
      await createCardType(data);
      flash("種別を登録しました。");
    }
    e.target.reset();
    $("#type-id").value = "";
    $("#type-submit").textContent = "種別を登録";
    await renderCardTypes();
  });

  // 商品フォーム。
  $("#product-form").addEventListener("submit", onProductSubmit);
  $("#product-cancel").addEventListener("click", resetProductForm);
  // 種別を切り替えたら編集モードは解除（別種別の商品を編集中のまま登録しないように）。
  $("#product-type-select").addEventListener("change", () => { resetProductForm(); renderProducts(); });

  // QR生成フォーム。
  $("#generate-form").addEventListener("submit", onGenerateSubmit);

  // QR一覧フィルタ。
  $("#cards-type-select").addEventListener("change", renderCards);
  $("#cards-status-select").addEventListener("change", renderCards);
  $("#cards-tbody").addEventListener("click", onCardsClick);

  // 印刷用URL一覧（Excel）。
  $("#print-btn").addEventListener("click", onExportUrlXlsx);

  // NE連携。
  $("#ne-csv-btn").addEventListener("click", onExportCsv);
  $("#ne-retry-btn").addEventListener("click", onRetryNe);
}

// ============================================================
// 印刷用URL一覧（Excel）
// ============================================================
async function onExportUrlXlsx() {
  const btn = $("#print-btn");
  btn.disabled = true;
  $("#print-result").textContent = "Excel生成中…";
  try {
    const params = new URLSearchParams();
    const typeId = $("#print-type-select").value;
    if (typeId) params.set("cardTypeId", typeId);
    if ($("#print-unprinted").checked) params.set("unprintedOnly", "1");
    if ($("#print-mark").checked) params.set("markPrinted", "1");
    if ($("#print-urlonly").checked) params.set("urlOnly", "1");
    const res = await authorizedFetch(`/api/adminExportUrlXlsx?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "qr-urls.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    $("#print-result").textContent = "Excelをダウンロードしました。";
  } catch (err) {
    $("#print-result").textContent = "";
    flash(`Excel出力に失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

// 種別セレクタ（商品・QR生成・一覧）を最新の種別で埋める。
function refreshTypeSelectors() {
  for (const sel of ["#product-type-select", "#generate-type-select", "#cards-type-select", "#print-type-select"]) {
    const el = $(sel);
    if (!el) continue;
    const prev = el.value;
    const isFilter = sel === "#cards-type-select" || sel === "#print-type-select";
    el.innerHTML = (isFilter ? `<option value="">すべての種別</option>` : "") +
      cardTypesCache.map((t) => `<option value="${t.id}">${esc(t.name)}（${yen(t.price)}）</option>`).join("");
    if (prev) el.value = prev;
  }
}

// ============================================================
// 選定可能商品（種別ごと / 親子構造）
// ============================================================
async function renderProducts() {
  const cardTypeId = $("#product-type-select").value;
  const tbody = $("#products-tbody");
  if (!cardTypeId) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">種別を選択してください。</td></tr>`;
    return;
  }
  const products = await listProductsByType(cardTypeId);
  productsCache = products;
  tbody.innerHTML = "";
  if (products.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">この種別にはまだ商品がありません。</td></tr>`;
    return;
  }
  for (const p of products) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.imageUrl ? `<img class="thumb" src="${esc(p.imageUrl)}" alt="">` : ""}</td>
      <td>${esc(p.name)}<div class="muted small">${esc(p.description)}</div></td>
      <td>${esc(p.neProductCode)}</td>
      <td>${p.active ? "有効" : "<span class='muted'>無効</span>"}</td>
      <td class="row-actions">
        <button data-act="edit" data-id="${p.id}">編集</button>
        <button data-act="toggle" data-id="${p.id}" data-active="${p.active}">${p.active ? "無効化" : "有効化"}</button>
        <button data-act="delete" data-id="${p.id}">削除</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

// 商品編集用に、現在描画中の商品をキャッシュ（フォームへ値を載せるため）。
let productsCache = [];

/** 商品フォームを新規モードに戻す。 */
function resetProductForm() {
  $("#product-form").reset();
  $("#product-id").value = "";
  $("#product-form-title").textContent = "商品の登録";
  $("#product-submit").textContent = "商品を登録";
  $("#product-cancel").hidden = true;
}

$("#products-tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === "edit") {
    // フォームに値を載せて更新モードにする（画像は選び直したときだけ差し替え）。
    const p = productsCache.find((x) => x.id === id);
    if (!p) return;
    $("#product-id").value = p.id;
    $("#product-name").value = p.name || "";
    $("#product-ne-code").value = p.neProductCode || "";
    $("#product-desc").value = p.description || "";
    $("#product-image").value = "";
    $("#product-form-title").textContent = "商品の編集";
    $("#product-submit").textContent = "商品を更新";
    $("#product-cancel").hidden = false;
    $("#product-name").focus();
  } else if (btn.dataset.act === "toggle") {
    await updateProduct(id, { active: btn.dataset.active !== "true" });
    await renderProducts();
  } else if (btn.dataset.act === "delete") {
    if (!confirm("この商品を削除しますか？")) return;
    await deleteProduct(id);
    flash("商品を削除しました。");
    if ($("#product-id").value === id) resetProductForm();
    await renderProducts();
  }
});

async function onProductSubmit(e) {
  e.preventDefault();
  const cardTypeId = $("#product-type-select").value;
  if (!cardTypeId) {
    flash("先に種別を選択してください。", "error");
    return;
  }
  const name = $("#product-name").value.trim();
  const neProductCode = $("#product-ne-code").value.trim();
  if (!name || !neProductCode) {
    flash("商品名とNE商品コードは必須です。", "error");
    return;
  }
  const editingId = $("#product-id").value;
  const submitBtn = $("#product-submit");
  submitBtn.disabled = true;
  try {
    const file = $("#product-image").files[0];
    const description = $("#product-desc").value.trim();

    if (editingId) {
      // 更新: 画像は選び直したときだけ差し替える。
      const patch = { name, description, neProductCode };
      if (file) {
        flash("画像をアップロード中…");
        patch.imageUrl = await uploadProductImage(cardTypeId, file);
      }
      await updateProduct(editingId, patch);
      flash("商品を更新しました。");
    } else {
      let imageUrl = "";
      if (file) {
        flash("画像をアップロード中…");
        imageUrl = await uploadProductImage(cardTypeId, file);
      }
      await createProduct({ cardTypeId, name, description, imageUrl, neProductCode });
      flash("商品を登録しました。");
    }
    resetProductForm();
    await renderProducts();
  } catch (err) {
    flash(`商品の${editingId ? "更新" : "登録"}に失敗しました: ${err?.message || err}`, "error");
  } finally {
    submitBtn.disabled = false;
  }
}

// ============================================================
// QR一括生成（Cloud Functions）
// ============================================================
async function onGenerateSubmit(e) {
  e.preventDefault();
  const cardTypeId = $("#generate-type-select").value;
  const count = Number($("#generate-count").value);
  if (!cardTypeId) {
    flash("種別を選択してください。", "error");
    return;
  }
  if (!Number.isInteger(count) || count < 1) {
    flash("生成個数は1以上の整数で指定してください。", "error");
    return;
  }
  const btn = $("#generate-submit");
  btn.disabled = true;
  $("#generate-result").textContent = "生成中…";
  try {
    const res = await authorizedFetch("/api/adminGenerateGiftCards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardTypeId, count }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const msg = data?.message || data?.code || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    $("#generate-result").textContent = `${data.created} 枚のQRカードを生成しました。`;
    flash(`${data.created} 枚を生成しました。`);
  } catch (err) {
    $("#generate-result").textContent = "";
    flash(`生成に失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// QR一覧（ステータス確認・memo入力）
// ============================================================
async function renderCards() {
  const cardTypeId = $("#cards-type-select").value || undefined;
  const status = $("#cards-status-select").value || undefined;
  const tbody = $("#cards-tbody");
  tbody.innerHTML = `<tr><td colspan="6" class="muted">読み込み中…</td></tr>`;
  const cards = await listCards({ cardTypeId, status });
  const typeName = (id) => cardTypesCache.find((t) => t.id === id)?.name || id;
  tbody.innerHTML = "";
  if (cards.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">該当するカードがありません。</td></tr>`;
    return;
  }
  for (const c of cards) {
    const used = c.status === CARD_STATUS.USED;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono small">${esc(c.token)}</td>
      <td>${esc(typeName(c.cardTypeId))}</td>
      <td>${used ? "<span class='badge badge-used'>使用済</span>" : "<span class='badge badge-unused'>未使用</span>"}</td>
      <td>${fmtDate(c.usedAt)}</td>
      <td><input class="memo-input" data-id="${c.id}" value="${esc(c.memo)}" placeholder="受注番号など"></td>
      <td class="row-actions"><button data-act="save-memo" data-id="${c.id}">memo保存</button></td>`;
    tbody.appendChild(tr);
  }
}

async function onCardsClick(e) {
  const btn = e.target.closest("button");
  if (!btn || btn.dataset.act !== "save-memo") return;
  const id = btn.dataset.id;
  const input = $(`.memo-input[data-id="${id}"]`);
  await updateCardMemo(id, input.value);
  flash("memo を保存しました。");
}

// ============================================================
// NE連携（CSV出力・自動投入リトライ）
// ============================================================
async function onExportCsv() {
  const btn = $("#ne-csv-btn");
  btn.disabled = true;
  try {
    const mark = $("#ne-csv-mark").checked ? "?markExported=1" : "";
    const res = await authorizedFetch(`/api/adminExportNeCsv${mark}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Shift_JIS のバイト列をそのまま Blob 化してダウンロード（ブラウザ側で文字コード変換しない）。
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ne-orders.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    flash("CSVをダウンロードしました。");
  } catch (err) {
    flash(`CSV出力に失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

async function onRetryNe() {
  const btn = $("#ne-retry-btn");
  btn.disabled = true;
  $("#ne-result").textContent = "投入中…";
  try {
    const res = await authorizedFetch("/api/adminRetryNeSubmissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data?.code || `HTTP ${res.status}`);
    $("#ne-result").textContent = data.configured
      ? `投入済 ${data.submitted} / 失敗 ${data.failed} / 対象外 ${data.skipped}`
      : "自動投入は未設定です（CSV運用中）。対象0件。";
  } catch (err) {
    $("#ne-result").textContent = "";
    flash(`リトライに失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

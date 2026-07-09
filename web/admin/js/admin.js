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
  listCards, updateCardMemo, getProductById, CARD_STATUS,
} from "./db.js";
import { uploadProductImage } from "./storage.js";
import { neStatusInfo, statusBadgeHtml } from "./status.js";
import { shortToken, filterCards } from "./cards-filter.js";
import { TOKEN } from "/shared/constants.js";

// ===== 小さなユーティリティ =====
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 読み込み中スピナー（CSS .spinner でアニメーション）。
const SPINNER = `<span class="spinner" aria-hidden="true"></span>`;

/** テーブルに「読み込み中…」行を表示（データ取得中）。 */
function tableLoading(tbody, colspan) {
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="loading-cell">${SPINNER}読み込み中…</td></tr>`;
}

/** テーブルに「データがありません」系の空メッセージ行を表示（0件時）。 */
function tableEmpty(tbody, colspan, msg) {
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="muted">${esc(msg)}</td></tr>`;
}

/** 結果表示欄に処理中インジケータ（スピナー＋メッセージ）を出す。 */
function busy(el, msg) {
  el.innerHTML = `${SPINNER}${esc(msg)}`;
  el.classList.add("busy");
}

/** 結果表示欄の処理中インジケータを解除して最終メッセージにする（空文字で消去）。 */
function busyDone(el, msg = "") {
  el.textContent = msg;
  el.classList.remove("busy");
}

/** 受け取り者用URL（PUBLIC_HOSTING_ORIGIN 相当 = 現在のオリジン + /g/<token>）。 */
function receiveUrl(token) {
  return `${location.origin}${TOKEN.URL_PREFIX}${token}`;
}

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

// タブ切替。切り替えたら、そのタブのデータ取得を自動で開始する（開いたら勝手に最新が出る挙動に統一）。
$$(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    $$(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-${tab}`; });
    loadTab(tab);
  });
});

/**
 * タブを開いた（表示された）タイミングで、そのタブが表示すべきデータを自動取得する。
 * 種別セレクタを持つタブは最新の種別を取り直してから一覧を描画する。
 */
async function loadTab(tab) {
  if (tab === "types") return renderCardTypes();
  if (tab === "products") { await refreshTypes(); return renderProducts(); }
  if (tab === "generate") return refreshTypes();
  if (tab === "cards") { await refreshTypes(); return renderCards(); }
  if (tab === "print") return refreshTypes();
  // ne タブは開いた時点で取得するデータがない（操作起点のCSV/リトライのみ）。
}

/** 種別を取り直してキャッシュとセレクタを最新化する（selectors を持つ各タブの前処理）。 */
async function refreshTypes() {
  cardTypesCache = await listCardTypes();
  refreshTypeSelectors();
}

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
  const tbody = $("#types-tbody");
  tableLoading(tbody, 5);
  cardTypesCache = await listCardTypes();
  refreshTypeSelectors();
  tbody.innerHTML = "";
  if (cardTypesCache.length === 0) {
    tableEmpty(tbody, 5, "まだ種別がありません。下のフォームから登録してください。");
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

  // QR一覧フィルタ。種別・状態はサーバ再取得、NE投入状態・検索はクライアント側でリアルタイム絞り込み。
  $("#cards-type-select").addEventListener("change", renderCards);
  $("#cards-status-select").addEventListener("change", renderCards);
  $("#cards-ne-select").addEventListener("change", applyCardFilters);
  $("#cards-search").addEventListener("input", applyCardFilters);
  $("#cards-tbody").addEventListener("click", onCardsClick);

  // 受注詳細モーダル（グループB）。
  $("#detail-body").addEventListener("click", onDetailClick);
  $("#detail-close").addEventListener("click", closeCardDetail);
  // オーバーレイの余白クリック・Escで閉じる。
  $("#detail-overlay").addEventListener("click", (e) => {
    if (e.target === $("#detail-overlay")) closeCardDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#detail-overlay").hidden) closeCardDetail();
  });

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
  busy($("#print-result"), "Excel生成中…");
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
    busyDone($("#print-result"), "Excelをダウンロードしました。");
  } catch (err) {
    busyDone($("#print-result"));
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
    tableEmpty(tbody, 5, "種別を選択してください。");
    return;
  }
  tableLoading(tbody, 5);
  const products = await listProductsByType(cardTypeId);
  productsCache = products;
  tbody.innerHTML = "";
  if (products.length === 0) {
    tableEmpty(tbody, 5, "この種別にはまだ商品がありません。");
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
  const submitLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "保存中…";
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
    // 成功時は resetProductForm がラベルを戻しているので、失敗で残った「保存中…」だけ復元する。
    if (submitBtn.textContent === "保存中…") submitBtn.textContent = submitLabel;
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
  busy($("#generate-result"), "生成中…");
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
    busyDone($("#generate-result"), `${data.created} 枚のQRカードを生成しました。`);
    flash(`${data.created} 枚を生成しました。`);
  } catch (err) {
    busyDone($("#generate-result"));
    flash(`生成に失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// QR一覧（ステータス確認・memo入力）
// ============================================================
// 現在描画中のカード一覧。詳細ビューがカードを引くために保持する。
let cardsCache = [];

/**
 * QR一覧の取得（サーバ側フィルタ＝種別・状態で直Firestore問い合わせ）→ 全件を cardsCache に保持。
 * NE投入状態・テキスト検索はクライアント側フィルタなので、取得後に applyCardFilters で描画する。
 */
async function renderCards() {
  const cardTypeId = $("#cards-type-select").value || undefined;
  const status = $("#cards-status-select").value || undefined;
  const tbody = $("#cards-tbody");
  tableLoading(tbody, 7);
  cardsCache = await listCards({ cardTypeId, status });
  applyCardFilters();
}

/**
 * cardsCache に対して NE投入状態フィルタ＋テキスト検索を適用して描画する（クライアント側・リアルタイム）。
 * 種別・状態の変更は renderCards（再取得）側で扱う。フィルタ本体は cards-filter.js（純粋関数）。
 */
function applyCardFilters() {
  const tbody = $("#cards-tbody");
  const neStatus = $("#cards-ne-select").value;               // "" or pending/submitting/...
  const query = $("#cards-search").value;
  const typeName = (id) => cardTypesCache.find((t) => t.id === id)?.name || id;

  const rows = filterCards(cardsCache, { neStatus, query });

  $("#cards-count").textContent = cardsCache.length
    ? `${rows.length} / ${cardsCache.length} 件`
    : "";

  tbody.innerHTML = "";
  if (rows.length === 0) {
    tableEmpty(tbody, 7, cardsCache.length === 0
      ? "該当するカードがありません。"
      : "検索・絞り込み条件に一致するカードがありません。");
    return;
  }
  for (const c of rows) {
    const url = receiveUrl(c.token);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono small col-token" title="${esc(c.token)}">${esc(shortToken(c.token))}</td>
      <td title="${esc(typeName(c.cardTypeId))}">${esc(typeName(c.cardTypeId))}</td>
      <td class="status-cell">${statusBadgeHtml(c)}</td>
      <td class="url-cell">
        <a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">${esc(url)}</a>
        <button class="copy-btn" data-act="copy-url" data-url="${esc(url)}" title="URLをコピー">コピー</button>
      </td>
      <td>${fmtDate(c.usedAt)}</td>
      <td><input class="memo-input" data-id="${c.id}" value="${esc(c.memo)}" placeholder="受注番号など"></td>
      <td class="row-actions">
        <button data-act="detail" data-id="${c.id}">詳細</button>
        <button data-act="save-memo" data-id="${c.id}">memo保存</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

async function onCardsClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.act === "copy-url") {
    await copyToClipboard(btn.dataset.url);
    return;
  }
  if (btn.dataset.act === "detail") {
    openCardDetail(btn.dataset.id);
    return;
  }
  if (btn.dataset.act === "save-memo") {
    const id = btn.dataset.id;
    const input = $(`.memo-input[data-id="${id}"]`);
    btn.disabled = true;
    try {
      await updateCardMemo(id, input.value);
      flash("memo を保存しました。");
    } catch (err) {
      flash(`memo保存に失敗しました: ${err?.message || err}`, "error");
    } finally {
      btn.disabled = false;
    }
  }
}

/** クリップボードにコピー（成功/失敗をflashで通知）。一覧・詳細で共用。 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    flash("URLをコピーしました。");
  } catch (_) {
    flash("コピーに失敗しました。URLを選択して手動でコピーしてください。", "error");
  }
}

// ============================================================
// 受注詳細ビュー（グループB：読み取り中心＋memo編集）
// ============================================================
// 詳細モーダルで表示中のカードID（memo保存の対象）。
let detailCardId = null;

/** 配送先住所の1行を「ラベル：値」で描画（値が空なら空欄表示）。 */
function addrRow(label, value) {
  return `<div class="detail-row"><span class="detail-label">${esc(label)}</span>` +
    `<span class="detail-value">${value ? esc(value) : "<span class='muted'>—</span>"}</span></div>`;
}

/** 詳細モーダルを開いてカードの受注内容を描画する。選択商品は Firestore から引く。 */
async function openCardDetail(cardId) {
  const card = cardsCache.find((c) => c.id === cardId);
  if (!card) return;
  detailCardId = cardId;
  const overlay = $("#detail-overlay");
  const body = $("#detail-body");
  overlay.hidden = false;
  body.innerHTML = `<div class="loading-cell">${SPINNER}読み込み中…</div>`;

  const type = cardTypesCache.find((t) => t.id === card.cardTypeId);
  const used = card.status === CARD_STATUS.USED;
  const url = receiveUrl(card.token);

  // 選択商品は使用済みのときだけ引く（未使用カードは selectedProductId を持たない）。
  let product = null;
  if (card.selectedProductId) {
    try {
      product = await getProductById(card.selectedProductId);
    } catch (_) { /* 取得失敗時は商品IDのみ表示にフォールバック */ }
  }
  // 描画中に別のカード詳細へ切り替わっていたら破棄（競合防止）。
  if (detailCardId !== cardId) return;

  const addr = card.shippingAddress || {};
  const ne = neStatusInfo(card.neStatus);

  const productHtml = card.selectedProductId
    ? `<div class="detail-product">
         ${product?.imageUrl ? `<img class="thumb-lg" src="${esc(product.imageUrl)}" alt="">` : ""}
         <div>
           <div class="detail-value">${esc(product?.name || "（商品情報を取得できませんでした）")}</div>
           <div class="muted small">${esc(product?.description || "")}</div>
           <div class="muted small">NE商品コード: ${esc(product?.neProductCode || "")}</div>
           <div class="muted small mono">productId: ${esc(card.selectedProductId)}</div>
         </div>
       </div>`
    : `<span class="muted">未選択（未使用カード）</span>`;

  body.innerHTML = `
    <section class="detail-section">
      <h3>カード</h3>
      ${addrRow("種別", type ? `${type.name}（${yen(type.price)}）` : card.cardTypeId)}
      ${addrRow("トークン", card.token)}
      <div class="detail-row">
        <span class="detail-label">状態</span>
        <span class="detail-value status-cell">${statusBadgeHtml(card)}</span>
      </div>
      ${used ? addrRow("確定日時", fmtDate(card.usedAt)) : ""}
      ${used ? addrRow("NE投入状態", ne.label) : ""}
    </section>

    <section class="detail-section">
      <h3>選択された商品</h3>
      ${productHtml}
    </section>

    <section class="detail-section">
      <h3>配送先住所</h3>
      ${used
        ? addrRow("氏名", addr.name) +
          addrRow("氏名カナ", addr.nameKana) +
          addrRow("郵便番号", addr.postalCode) +
          addrRow("都道府県", addr.prefecture) +
          addrRow("住所", addr.address) +
          addrRow("建物名・部屋番号", addr.building) +
          addrRow("電話番号", addr.phone)
        : `<span class="muted">未入力（未使用カード）</span>`}
    </section>

    <section class="detail-section">
      <h3>連絡先・配達希望</h3>
      ${used
        ? addrRow("メールアドレス", card.recipientEmail) +
          addrRow("配達希望日", card.deliveryDate || "指定なし（おまかせ）") +
          addrRow("配達希望時間帯", card.deliveryTime || "指定なし（おまかせ）")
        : `<span class="muted">未入力（未使用カード）</span>`}
    </section>

    <section class="detail-section">
      <h3>受け取り者用URL</h3>
      <div class="url-cell">
        <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>
        <button class="copy-btn" type="button" data-act="detail-copy-url" data-url="${esc(url)}">コピー</button>
      </div>
    </section>

    <section class="detail-section">
      <h3>memo（管理者記入欄）</h3>
      <textarea id="detail-memo" class="detail-memo" rows="2" placeholder="受注番号など突合用">${esc(card.memo)}</textarea>
      <div><button id="detail-memo-save" type="button">memoを保存</button></div>
    </section>`;
}

/** 詳細モーダルを閉じる。 */
function closeCardDetail() {
  $("#detail-overlay").hidden = true;
  detailCardId = null;
}

/** 詳細モーダル内のクリック（コピー・memo保存）。 */
async function onDetailClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.act === "detail-copy-url") {
    await copyToClipboard(btn.dataset.url);
    return;
  }
  if (btn.id === "detail-memo-save") {
    const id = detailCardId;
    if (!id) return;
    const memo = $("#detail-memo").value;
    btn.disabled = true;
    try {
      await updateCardMemo(id, memo);
      // キャッシュと一覧の入力欄も同期させ、閉じた後に古い値が残らないようにする。
      const cached = cardsCache.find((c) => c.id === id);
      if (cached) cached.memo = memo;
      const listInput = $(`.memo-input[data-id="${id}"]`);
      if (listInput) listInput.value = memo;
      flash("memo を保存しました。");
    } catch (err) {
      flash(`memo保存に失敗しました: ${err?.message || err}`, "error");
    } finally {
      btn.disabled = false;
    }
  }
}

// ============================================================
// NE連携（CSV出力・自動投入リトライ）
// ============================================================
async function onExportCsv() {
  const btn = $("#ne-csv-btn");
  btn.disabled = true;
  busy($("#ne-result"), "CSV生成中…");
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
    busyDone($("#ne-result"), "CSVをダウンロードしました。");
    flash("CSVをダウンロードしました。");
  } catch (err) {
    busyDone($("#ne-result"));
    flash(`CSV出力に失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

async function onRetryNe() {
  const btn = $("#ne-retry-btn");
  btn.disabled = true;
  busy($("#ne-result"), "投入中…");
  try {
    const res = await authorizedFetch("/api/adminRetryNeSubmissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data?.code || `HTTP ${res.status}`);
    busyDone($("#ne-result"), data.configured
      ? `投入済 ${data.submitted} / 失敗 ${data.failed} / 対象外 ${data.skipped}`
      : "自動投入は未設定です（CSV運用中）。対象0件。");
  } catch (err) {
    busyDone($("#ne-result"));
    flash(`リトライに失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

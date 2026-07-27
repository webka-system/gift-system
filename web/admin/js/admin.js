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
  listCouponTypes, createCouponType,
  listProductsByType, createProduct, updateProduct, deleteProduct,
  listCards, updateCardMemo, getProductById, getCard, deleteField, CARD_STATUS,
} from "./db.js";
import { uploadProductImage } from "./storage.js";
import { neStatusInfo, statusBadgeHtml, couponStatusInfo } from "./status.js";
import { filterCards, LOT_NONE } from "./cards-filter.js";
import { TOKEN, PRODUCT, PREFECTURES, DELIVERY, NE_STATUS, CARD_KIND, COUPON, COUPON_STATUS } from "/shared/constants.js";
import { expiryInfo } from "/shared/expiry.js";

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
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-cell">${esc(msg)}</td></tr>`;
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

/**
 * 受け取り者用URL（現在のオリジン + 接頭辞 + token）。
 * kind により接頭辞を切り替える（catalog=/g/ 商品選択ページ / coupon=/gc/ クーポン専用ページ）。
 * kind 未指定は catalog（従来どおり /g/）。
 */
function receiveUrl(token, kind) {
  const prefix = kind === CARD_KIND.COUPON ? TOKEN.COUPON_URL_PREFIX : TOKEN.URL_PREFIX;
  return `${location.origin}${prefix}${token}`;
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
// クーポン種別（kind=coupon）のキャッシュ。catalog とは別クエリ（listCouponTypes）で取得。
let couponTypesCache = [];

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

// 取り扱いモード（catalog / coupon）。カタログギフトと株主優待クーポンを混在させず上位で分ける。
let currentMode = "catalog";
/** 現在モードの kind（一覧・生成・印刷の対象種類）。 */
function modeKind() { return currentMode === "coupon" ? CARD_KIND.COUPON : CARD_KIND.CATALOG; }

// タブを開く（アクティブ化＋データ取得）。クリックとモード切替の両方から使う。
function activateTab(tab) {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-panel").forEach((p) => { p.hidden = p.id !== `tab-${tab}`; });
  loadTab(tab);
}

// タブ切替。切り替えたら、そのタブのデータ取得を自動で開始する（開いたら勝手に最新が出る挙動に統一）。
$$(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

/**
 * 取り扱いモードを切り替える（カタログギフト / 株主優待クーポン）。
 * タブの見せ方（カタログ専用タブの表示/非表示・種別タブのラベル）と、
 * 一覧/生成/印刷の対象 kind を切り替える。データモデルは kind で共通のまま、見せ方だけ分ける。
 */
function setMode(mode) {
  currentMode = mode;
  const app = $("#app-view");
  if (app) app.dataset.mode = mode;
  $$(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  // カタログ専用タブ（選定可能商品・NE連携）はクーポンモードでは隠す。
  $$(".tab-btn[data-catalog-only]").forEach((b) => { b.hidden = mode !== "catalog"; });
  // 種別タブのラベルをモードに合わせて切替。
  const typesBtn = $('.tab-btn[data-tab="types"]');
  if (typesBtn) typesBtn.textContent = mode === "coupon" ? typesBtn.dataset.labelCoupon : typesBtn.dataset.labelCatalog;
  // 現在アクティブなタブが隠れた（カタログ専用→クーポンで消えた）ら、種別タブへ退避。
  let active = $(".tab-btn.active");
  if (!active || active.hidden) active = typesBtn;
  activateTab(active ? active.dataset.tab : "types");
}

$$(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
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
  if (tab === "print") { await refreshTypes(); return populatePrintLots(); }
  // ne タブは開いた時点で取得するデータがない（操作起点のCSV/リトライのみ）。
}

/** 種別を取り直してキャッシュとセレクタを最新化する（selectors を持つ各タブの前処理）。 */
async function refreshTypes() {
  [cardTypesCache, couponTypesCache] = await Promise.all([listCardTypes(), listCouponTypes()]);
  refreshTypeSelectors();
}

// アプリ初期化（ログイン後）。
let booted = false;
async function bootApp() {
  if (booted) return;
  booted = true;
  wireForms();
  setMode("catalog"); // 既定はカタログ。種別タブを開いて初期描画する。
}

// ============================================================
// カード種別
// ============================================================
async function renderCardTypes() {
  const tbody = $("#types-tbody");
  tableLoading(tbody, 5);
  // catalog / coupon の両キャッシュを取り直す（生成セレクタが両方を必要とするため）。
  [cardTypesCache, couponTypesCache] = await Promise.all([listCardTypes(), listCouponTypes()]);
  refreshTypeSelectors();
  tbody.innerHTML = "";
  if (cardTypesCache.length === 0) {
    tableEmpty(tbody, 5, "まだ種別がありません。下のフォームから登録してください。");
  } else {
    for (const t of cardTypesCache) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(t.name)}</td>
        <td>${yen(t.price)}</td>
        <td>${esc(t.cardProductCode)}</td>
        <td>${t.active ? "有効" : "<span class='muted'>無効</span>"}</td>
        <td>
          <div class="row-actions">
            <button data-act="toggle" data-id="${t.id}">${t.active ? "無効化" : "有効化"}</button>
            <button data-act="edit" data-id="${t.id}">編集</button>
          </div>
        </td>`;
      tbody.appendChild(tr);
    }
  }
  renderCouponTypes();
}

/** クーポン種別（kind=coupon）の一覧を描画する。catalog とは別テーブル・別フォーム。 */
function renderCouponTypes() {
  const tbody = $("#coupon-types-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (couponTypesCache.length === 0) {
    tableEmpty(tbody, 5, "まだクーポン種別がありません。下のフォームから登録してください。");
    return;
  }
  for (const t of couponTypesCache) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(t.name)}</td>
      <td>${couponDiscountText(t.couponConfig)}</td>
      <td>${t.couponConfig?.minimumPrice ? yen(t.couponConfig.minimumPrice) : "<span class='muted'>下限なし</span>"}</td>
      <td>${t.active ? "有効" : "<span class='muted'>無効</span>"}</td>
      <td>
        <div class="row-actions">
          <button data-act="toggle" data-id="${t.id}">${t.active ? "無効化" : "有効化"}</button>
          <button data-act="edit" data-id="${t.id}">編集</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }
}

/** クーポン割引の表示文字列（"10% OFF" / "500円 OFF"）。 */
function couponDiscountText(cfg) {
  if (!cfg) return "";
  if (cfg.discountType === COUPON.DISCOUNT_TYPE.RATE) return `${esc(cfg.discountValue)}% OFF`;
  return `${yen(cfg.discountValue)} OFF`;
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
    $("#type-expiry").value = t.expiryDays ?? "";
    $("#type-submit").textContent = "種別を更新";
    $("#type-name").focus();
  }
});

// クーポン種別テーブルの操作（有効/無効・編集）。catalog とは別テーブル。
$("#coupon-types-tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const t = couponTypesCache.find((x) => x.id === btn.dataset.id);
  if (!t) return;
  if (btn.dataset.act === "toggle") {
    await setCardTypeActive(t.id, !t.active);
    flash(`「${t.name}」を${t.active ? "無効化" : "有効化"}しました。`);
    await renderCardTypes();
  } else if (btn.dataset.act === "edit") {
    $("#coupon-type-id").value = t.id;
    $("#coupon-type-name").value = t.name;
    $("#coupon-type-discount-type").value = t.couponConfig?.discountType ?? COUPON.DISCOUNT_TYPE.RATE;
    $("#coupon-type-value").value = t.couponConfig?.discountValue ?? "";
    $("#coupon-type-min").value = t.couponConfig?.minimumPrice ?? "";
    updateCouponValueLabel();
    $("#coupon-type-submit").textContent = "クーポン種別を更新";
    $("#coupon-type-cancel").hidden = false;
    $("#coupon-type-name").focus();
  }
});

/** 割引方式に応じて割引値の入力ラベル（%か円）を切り替える。 */
function updateCouponValueLabel() {
  const isRate = $("#coupon-type-discount-type").value === COUPON.DISCOUNT_TYPE.RATE;
  $("#coupon-type-value-label").textContent = isRate ? "割引率（%）" : "割引額（円）";
}

/** クーポン種別フォームを新規登録モードに戻す。 */
function resetCouponTypeForm() {
  $("#coupon-type-form").reset();
  $("#coupon-type-id").value = "";
  $("#coupon-type-submit").textContent = "クーポン種別を登録";
  $("#coupon-type-cancel").hidden = true;
  updateCouponValueLabel();
}

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
    // 有効期限（日数）: 空欄＝無期限。正の整数のみ有効。
    const expRaw = $("#type-expiry").value.trim();
    const expDays = expRaw === "" ? null : Number(expRaw);
    if (expRaw !== "" && (!Number.isInteger(expDays) || expDays <= 0)) {
      flash("有効期限（日数）は1以上の整数、または空欄にしてください。", "error");
      return;
    }
    if (id) {
      // 更新: 空欄なら expiryDays を削除（無期限に戻す）。
      await updateCardType(id, { ...data, expiryDays: expDays ?? deleteField() });
      flash("種別を更新しました。");
    } else {
      await createCardType({ ...data, expiryDays: expDays ?? undefined });
      flash("種別を登録しました。");
    }
    e.target.reset();
    $("#type-id").value = "";
    $("#type-submit").textContent = "種別を登録";
    await renderCardTypes();
  });

  // クーポン種別フォーム（新規/更新兼用）。
  $("#coupon-type-discount-type").addEventListener("change", updateCouponValueLabel);
  $("#coupon-type-cancel").addEventListener("click", resetCouponTypeForm);
  $("#coupon-type-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#coupon-type-id").value;
    const name = $("#coupon-type-name").value.trim();
    const discountType = $("#coupon-type-discount-type").value;
    const discountValue = Number($("#coupon-type-value").value);
    const minRaw = $("#coupon-type-min").value.trim();
    const minimumPrice = minRaw === "" ? undefined : Number(minRaw);
    if (!name || !Number.isFinite(discountValue) || discountValue <= 0) {
      flash("表示名と割引値（1以上）は必須です。", "error");
      return;
    }
    if (discountType === COUPON.DISCOUNT_TYPE.RATE && discountValue > 100) {
      flash("割引率は100%以下で指定してください。", "error");
      return;
    }
    if (minRaw !== "" && (!Number.isFinite(minimumPrice) || minimumPrice <= 0)) {
      flash("最低購入額は1以上の数値、または空欄にしてください。", "error");
      return;
    }
    if (id) {
      // 更新: couponConfig をまるごと差し替え（最低購入額の削除も反映）。
      const couponConfig = { discountType, discountValue };
      if (minimumPrice) couponConfig.minimumPrice = minimumPrice;
      await updateCardType(id, { name, couponConfig });
      flash("クーポン種別を更新しました。");
    } else {
      await createCouponType({ name, discountType, discountValue, minimumPrice });
      flash("クーポン種別を登録しました。");
    }
    resetCouponTypeForm();
    await renderCardTypes();
  });

  // 商品フォーム。
  $("#product-form").addEventListener("submit", onProductSubmit);
  $("#product-cancel").addEventListener("click", resetProductForm);
  // 追加画像（選択・削除プレビュー）。
  $("#product-add-image-input").addEventListener("change", onAddImagesPicked);
  $("#product-add-images").addEventListener("click", onAddImageDelete);
  // 種別を切り替えたら編集モードは解除（別種別の商品を編集中のまま登録しないように）。
  $("#product-type-select").addEventListener("change", () => { resetProductForm(); renderProducts(); });

  // 商品詳細モーダル（複数画像ギャラリー・セット内容・説明）。
  $("#product-detail-body").addEventListener("click", onProductDetailClick);
  $("#product-detail-close").addEventListener("click", closeProductDetail);
  $("#product-detail-overlay").addEventListener("click", (e) => {
    if (e.target === $("#product-detail-overlay")) closeProductDetail();
  });

  // QR生成フォーム。
  $("#generate-form").addEventListener("submit", onGenerateSubmit);
  // 種別を切り替えたら kind に応じて有効期限UIを出し分ける。
  $("#generate-type-select").addEventListener("change", syncGenerateExpiryField);

  // QR一覧フィルタ。種別・状態はサーバ再取得、NE投入状態・検索はクライアント側でリアルタイム絞り込み。
  $("#cards-type-select").addEventListener("change", renderCards);
  $("#cards-status-select").addEventListener("change", renderCards);
  $("#cards-ne-select").addEventListener("change", applyCardFilters);
  $("#cards-lot-select").addEventListener("change", applyCardFilters);
  $("#cards-gen-from").addEventListener("change", applyCardFilters);
  $("#cards-gen-to").addEventListener("change", applyCardFilters);
  $("#cards-expiry-select").addEventListener("change", applyCardFilters);
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
    if (e.key !== "Escape") return;
    if (!$("#detail-overlay").hidden) closeCardDetail();
    if (!$("#product-detail-overlay").hidden) closeProductDetail();
  });

  // 印刷用URL一覧（Excel）。種別を変えたらロット候補も選び直す。
  $("#print-btn").addEventListener("click", onExportUrlXlsx);
  $("#print-type-select").addEventListener("change", populatePrintLots);

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
    // 現在モードの kind を渡し、「すべての種別」でも他方の種類が混ざらないようにする。
    params.set("kind", modeKind());
    const typeId = $("#print-type-select").value;
    if (typeId) params.set("cardTypeId", typeId);
    const lot = $("#print-lot-select").value;
    if (lot) params.set("batchId", lot);
    const genFrom = $("#print-gen-from").value;
    if (genFrom) params.set("generatedFrom", genFrom);
    const genTo = $("#print-gen-to").value;
    if (genTo) params.set("generatedTo", genTo);
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
/** 種別セレクタの表示ラベル接尾辞（catalog=価格 / coupon=割引内容）。 */
function typeOptionSuffix(t) {
  return currentMode === "coupon" ? `（${couponDiscountText(t.couponConfig)}）` : `（${yen(t.price)}）`;
}

function refreshTypeSelectors() {
  // 現在モードの種別（catalog種別 or クーポン種別）。混在させない。
  const modeTypes = currentMode === "coupon" ? couponTypesCache : cardTypesCache;

  // 商品タブは常にカタログ種別（選定可能商品はカタログ専用）。
  const psel = $("#product-type-select");
  if (psel) {
    const prev = psel.value;
    psel.innerHTML = cardTypesCache.map((t) => `<option value="${t.id}">${esc(t.name)}（${yen(t.price)}）</option>`).join("");
    if (prev) psel.value = prev;
  }

  // 一覧・印刷の種別フィルタは現在モードの種別（＋すべて）。
  for (const sel of ["#cards-type-select", "#print-type-select"]) {
    const el = $(sel);
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = `<option value="">すべての種別</option>` +
      modeTypes.map((t) => `<option value="${t.id}">${esc(t.name)}${typeOptionSuffix(t)}</option>`).join("");
    if (prev) el.value = prev;
  }

  // 生成セレクタも現在モードの種別のみ（data-kind でクーポン時の有効期限UIを出し分け）。
  const gsel = $("#generate-type-select");
  if (gsel) {
    const prev = gsel.value;
    gsel.innerHTML = modeTypes
      .map((t) => `<option value="${t.id}" data-kind="${modeKind()}">${esc(t.name)}${typeOptionSuffix(t)}</option>`)
      .join("");
    if (prev) gsel.value = prev;
    syncGenerateExpiryField();
  }
}

/** 生成セレクタで選ばれた種別の kind を返す（"catalog" | "coupon"）。 */
function selectedGenerateKind() {
  const opt = $("#generate-type-select")?.selectedOptions?.[0];
  return opt?.dataset?.kind || CARD_KIND.CATALOG;
}

/** クーポン種別を選んだときだけ有効期限（絶対日付）の入力欄と注記を表示する。 */
function syncGenerateExpiryField() {
  const isCoupon = selectedGenerateKind() === CARD_KIND.COUPON;
  const field = $("#generate-expiry-field");
  const note = $("#generate-note");
  if (field) field.hidden = !isCoupon;
  if (note) note.hidden = !isCoupon;
}

// ============================================================
// 選定可能商品（種別ごと / 親子構造）
// ============================================================
async function renderProducts() {
  const cardTypeId = $("#product-type-select").value;
  const tbody = $("#products-tbody");
  if (!cardTypeId) {
    tableEmpty(tbody, 4, "種別を選択してください。");
    return;
  }
  tableLoading(tbody, 4);
  const products = await listProductsByType(cardTypeId);
  productsCache = products;
  tbody.innerHTML = "";
  if (products.length === 0) {
    tableEmpty(tbody, 4, "この種別にはまだ商品がありません。");
    return;
  }
  // 一覧は簡潔に（サムネ＋名前＋状態）。複数画像・セット内容・説明は「詳細」ビューで見せる。
  for (const p of products) {
    const extra = (p.additionalImages?.length || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.imageUrl ? `<img class="thumb" src="${esc(p.imageUrl)}" alt="">` : ""}</td>
      <td>${esc(p.name)}${extra ? `<div class="muted small">＋画像${extra}枚</div>` : ""}</td>
      <td>${p.active ? "有効" : "<span class='muted'>無効</span>"}</td>
      <td>
        <div class="row-actions">
          <button data-act="product-detail" data-id="${p.id}">詳細</button>
          <button data-act="edit" data-id="${p.id}">編集</button>
          <button data-act="toggle" data-id="${p.id}" data-active="${p.active}">${p.active ? "無効化" : "有効化"}</button>
          <button data-act="delete" data-id="${p.id}">削除</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }
}

// 商品編集用に、現在描画中の商品をキャッシュ（フォームへ値を載せるため）。
let productsCache = [];

// 追加画像フォームの状態。要素は既存URL or 新規ファイル:
//   { kind:"url", url } … 既存の追加画像（編集時に読み込む）
//   { kind:"file", file, preview } … これから登録する新規ファイル（preview は ObjectURL）
let productAddImages = [];

/** 追加画像フォームのプレビュー（サムネ＋削除ボタン）を状態から描画する。 */
function renderAddImages() {
  const wrap = $("#product-add-images");
  wrap.innerHTML = productAddImages.map((it, i) => {
    const src = it.kind === "url" ? it.url : it.preview;
    return `<div class="add-image">
      <img src="${esc(src)}" alt="">
      <button type="button" class="add-image-del" data-index="${i}" title="削除">×</button>
    </div>`;
  }).join("");
  const remain = PRODUCT.MAX_ADDITIONAL_IMAGES - productAddImages.length;
  $("#product-add-image-input").disabled = remain <= 0;
  $("#product-add-image-input").title = remain <= 0 ? "追加画像は最大" + PRODUCT.MAX_ADDITIONAL_IMAGES + "枚までです" : "";
}

/** 追加画像フォームの状態を空に戻す（ObjectURL を解放してから）。 */
function clearAddImages() {
  for (const it of productAddImages) {
    if (it.kind === "file" && it.preview) URL.revokeObjectURL(it.preview);
  }
  productAddImages = [];
  renderAddImages();
}

/** 商品フォームを新規モードに戻す。 */
function resetProductForm() {
  $("#product-form").reset();
  $("#product-id").value = "";
  clearAddImages();
  $("#product-form-title").textContent = "商品の登録";
  $("#product-submit").textContent = "商品を登録";
  $("#product-cancel").hidden = true;
}

$("#products-tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === "product-detail") {
    openProductDetail(id);
    return;
  }
  if (btn.dataset.act === "edit") {
    // フォームに値を載せて更新モードにする（メイン画像は選び直したときだけ差し替え）。
    const p = productsCache.find((x) => x.id === id);
    if (!p) return;
    $("#product-id").value = p.id;
    $("#product-name").value = p.name || "";
    $("#product-ne-code").value = p.neProductCode || "";
    $("#product-desc").value = p.description || "";
    $("#product-set").value = p.setContents || "";
    $("#product-image").value = "";
    $("#product-add-image-input").value = "";
    // 既存の追加画像を編集状態に読み込む（削除・追加ができる）。
    clearAddImages();
    productAddImages = (p.additionalImages || []).map((url) => ({ kind: "url", url }));
    renderAddImages();
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
    // セット内容: 1行=1項目。前後空白を落とし、空行を除いて改行区切りで保存。
    const setContents = $("#product-set").value
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join("\n");

    // 追加画像: 既存URLはそのまま、新規ファイルはアップロードしてURL化（順序維持）。
    const additionalImages = [];
    for (const it of productAddImages) {
      if (it.kind === "url") {
        additionalImages.push(it.url);
      } else {
        flash("追加画像をアップロード中…");
        additionalImages.push(await uploadProductImage(cardTypeId, it.file));
      }
    }

    if (editingId) {
      // 更新: メイン画像は選び直したときだけ差し替え。追加画像・セット内容は管理状態で常に上書き。
      const patch = { name, description, neProductCode, additionalImages, setContents };
      if (file) {
        flash("メイン画像をアップロード中…");
        patch.imageUrl = await uploadProductImage(cardTypeId, file);
      }
      await updateProduct(editingId, patch);
      flash("商品を更新しました。");
    } else {
      let imageUrl = "";
      if (file) {
        flash("メイン画像をアップロード中…");
        imageUrl = await uploadProductImage(cardTypeId, file);
      }
      await createProduct({ cardTypeId, name, description, imageUrl, neProductCode, additionalImages, setContents });
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

/** 追加画像ファイルが選択されたとき、上限まで状態に積んでプレビュー更新。 */
function onAddImagesPicked(e) {
  const files = [...e.target.files];
  for (const file of files) {
    if (productAddImages.length >= PRODUCT.MAX_ADDITIONAL_IMAGES) {
      flash(`追加画像は最大${PRODUCT.MAX_ADDITIONAL_IMAGES}枚までです。`, "error");
      break;
    }
    productAddImages.push({ kind: "file", file, preview: URL.createObjectURL(file) });
  }
  e.target.value = ""; // 同じファイルを選び直せるように毎回クリア。
  renderAddImages();
}

/** 追加画像プレビューの×で当該画像を状態から取り除く。 */
function onAddImageDelete(e) {
  const btn = e.target.closest(".add-image-del");
  if (!btn) return;
  const i = Number(btn.dataset.index);
  const it = productAddImages[i];
  if (it?.kind === "file" && it.preview) URL.revokeObjectURL(it.preview);
  productAddImages.splice(i, 1);
  renderAddImages();
}

// ============================================================
// 商品詳細ビュー（複数画像ギャラリー・セット内容・説明）
// ============================================================
/** セット内容（改行区切り）を「・」付きリストHTMLに。空なら空文字。 */
function setContentsListHtml(text) {
  const items = String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return "";
  return `<ul class="set-list">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

/** 画像配列（先頭=メイン）から、メイン大画像＋サムネ切替のギャラリーHTMLを組む。 */
function galleryHtml(images) {
  const imgs = images.filter(Boolean);
  if (!imgs.length) return `<div class="gallery-empty muted">画像はありません。</div>`;
  const thumbs = imgs.length > 1
    ? `<div class="gallery-thumbs">${imgs.map((u, i) =>
        `<img class="gallery-thumb${i === 0 ? " active" : ""}" data-src="${esc(u)}" src="${esc(u)}" alt="">`).join("")}</div>`
    : "";
  return `<div class="gallery">
      <img class="gallery-main" src="${esc(imgs[0])}" alt="">
      ${thumbs}
    </div>`;
}

/** 商品詳細モーダルを開く（複数画像・セット内容・説明・NEコード・状態）。 */
function openProductDetail(id) {
  const p = productsCache.find((x) => x.id === id);
  if (!p) return;
  const images = [p.imageUrl, ...(p.additionalImages || [])];
  const setHtml = setContentsListHtml(p.setContents);
  $("#product-detail-body").innerHTML = `
    <section class="detail-section">${galleryHtml(images)}</section>
    <section class="detail-section">
      <h3>${esc(p.name)}</h3>
      ${p.description ? `<p>${esc(p.description)}</p>` : `<p class="muted">説明はありません。</p>`}
    </section>
    <section class="detail-section">
      <h3>セット内容</h3>
      ${setHtml || `<p class="muted">未設定</p>`}
    </section>
    <section class="detail-section">
      ${addrRow("NE商品コード", p.neProductCode)}
      ${addrRow("状態", p.active ? "有効" : "無効")}
    </section>`;
  $("#product-detail-overlay").hidden = false;
}

/** 商品詳細モーダルを閉じる。 */
function closeProductDetail() {
  $("#product-detail-overlay").hidden = true;
}

/** 商品詳細モーダル内クリック（サムネで大画像を切り替え）。 */
function onProductDetailClick(e) {
  const thumb = e.target.closest(".gallery-thumb");
  if (!thumb) return;
  const main = $(".gallery-main", $("#product-detail-body"));
  if (main) main.src = thumb.dataset.src;
  for (const t of $$(".gallery-thumb", $("#product-detail-body"))) t.classList.toggle("active", t === thumb);
}

// ============================================================
// QR一括生成（Cloud Functions）
// ============================================================
/** 今日の日付（JST・"YYYY-MM-DD"）。クーポン有効期限が過去でないことの簡易チェックに使う。 */
function jstTodayStr() {
  const j = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}-${String(j.getUTCDate()).padStart(2, "0")}`;
}

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
  // クーポン種別のときは有効期限（絶対日付）を必須で送る（ロット単位 / B案）。
  const payload = { cardTypeId, count };
  if (selectedGenerateKind() === CARD_KIND.COUPON) {
    const expiryDate = $("#generate-expiry").value; // "YYYY-MM-DD"
    if (!expiryDate) {
      flash("クーポンの有効期限（絶対日付）を指定してください。", "error");
      return;
    }
    const todayJst = jstTodayStr();
    if (expiryDate < todayJst) {
      flash("有効期限は本日以降の日付を指定してください。", "error");
      return;
    }
    payload.expiryDate = expiryDate;
  }
  const btn = $("#generate-submit");
  btn.disabled = true;
  busy($("#generate-result"), "生成中…");
  try {
    const res = await authorizedFetch("/api/adminGenerateGiftCards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
  populateLotFilter();
  applyCardFilters();
}

// ロットのプルダウンに直近何件まで出すか（それより古いロットは生成日の範囲指定で絞り込む）。
const LOT_RECENT_LIMIT = 25;

/**
 * ロット（生成バッチ）絞り込みの <option> HTML を、カード配列から組み立てる。
 * 生成日時の新しい順に **直近 LOT_RECENT_LIMIT 件だけ**表示（肥大化防止）。古い分は日付範囲で絞る。
 * batchId ごとに生成日時ラベル＋枚数。生成日時不明（batchId 無し）はまとめて1項目（LOT_NONE）。
 * QR一覧フィルタと印刷タブの両方で共用する。
 */
function lotOptionsHtml(cards) {
  const byBatch = new Map(); // batchId -> { generatedAt, count }
  let noneCount = 0;
  for (const c of cards) {
    if (!c.batchId) { noneCount++; continue; }
    const e = byBatch.get(c.batchId) || { generatedAt: c.generatedAt, count: 0 };
    e.count++;
    byBatch.set(c.batchId, e);
  }
  const entries = [...byBatch.entries()].sort((a, b) => tsMillis(b[1].generatedAt) - tsMillis(a[1].generatedAt));
  const shown = entries.slice(0, LOT_RECENT_LIMIT);
  let html = `<option value="">すべて</option>`;
  for (const [batchId, e] of shown) {
    html += `<option value="${esc(batchId)}">${esc(fmtDate(e.generatedAt) || "不明")}（${e.count}枚）</option>`;
  }
  const hidden = entries.length - shown.length;
  if (hidden > 0) {
    html += `<option value="" disabled>― 古いロット ${hidden} 件は「生成日の範囲」で絞り込み ―</option>`;
  }
  if (noneCount) html += `<option value="${LOT_NONE}">生成日時不明（${noneCount}枚）</option>`;
  return html;
}

/** カードの生成日（JST・YYYY-MM-DD）。generatedAt 無しは null。生成日の範囲フィルタで使う。 */
function cardGenDateJst(c) {
  const ms = typeof c.generatedAt?.toMillis === "function" ? c.generatedAt.toMillis() : null;
  if (ms === null) return null;
  const j = new Date(ms + 9 * 60 * 60 * 1000); // JST
  return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}-${String(j.getUTCDate()).padStart(2, "0")}`;
}

/** カードを現在モードの kind に絞る（catalog/coupon の混在を避ける）。 */
function filterByMode(cards) {
  const mk = modeKind();
  return cards.filter((c) => (c.kind ?? CARD_KIND.CATALOG) === mk);
}

/** QR一覧のロット絞り込みを取得済みカードから最新化する（現在モードのカードのみ）。 */
function populateLotFilter() {
  const sel = $("#cards-lot-select");
  const prev = sel.value;
  sel.innerHTML = lotOptionsHtml(filterByMode(cardsCache));
  if (prev) sel.value = prev;
}

/** 印刷タブのロット絞り込みを、選択中の種別のカードから組み立てる（現在モードのカードのみ）。 */
async function populatePrintLots() {
  const sel = $("#print-lot-select");
  if (!sel) return;
  const prev = sel.value;
  const cardTypeId = $("#print-type-select").value || undefined;
  let cards = [];
  try { cards = await listCards({ cardTypeId }); } catch (_) { /* 空で続行 */ }
  sel.innerHTML = lotOptionsHtml(filterByMode(cards));
  if (prev) sel.value = prev;
}

/** Firestore Timestamp → ミリ秒（ソート用。無ければ0）。 */
function tsMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

/**
 * cardsCache に対して NE投入状態フィルタ＋テキスト検索を適用して描画する（クライアント側・リアルタイム）。
 * 種別・状態の変更は renderCards（再取得）側で扱う。フィルタ本体は cards-filter.js（純粋関数）。
 */
// クーポンの「期限間近」しきい値（日）。QR一覧の「期限が近い（7日以内）」と揃える。
const COUPON_NEAR_DAYS = 7;

/**
 * カードの有効期限判定。
 *   - catalog: 種別デフォルト expiryDays ＋個別上書き（相対日数・cardTypesCache 参照）＝従来どおり。
 *   - coupon : couponExpiryAt（絶対日付・ロット単位）で判定。expiryInfo と同じ形の結果を返す。
 */
function cardExpiry(c) {
  if ((c.kind ?? CARD_KIND.CATALOG) === CARD_KIND.COUPON) {
    const ms = tsMillis(c.couponExpiryAt);
    if (!ms) return { hasExpiry: false, expired: false, near: false };
    const now = Date.now();
    const remainingDays = Math.ceil((ms - now) / 86400000);
    return {
      hasExpiry: true,
      expired: now > ms,
      near: now <= ms && remainingDays <= COUPON_NEAR_DAYS,
      expiryMs: ms,
      remainingDays,
    };
  }
  const type = cardTypesCache.find((t) => t.id === c.cardTypeId);
  return expiryInfo({
    generatedAtMs: typeof c.generatedAt?.toMillis === "function" ? c.generatedAt.toMillis() : undefined,
    overrideDays: c.expiryDaysOverride,
    typeDays: type?.expiryDays,
    nowMs: Date.now(),
  });
}

/** 有効期限の表示文字列（無期限／期限日／期限切れ）。 */
function expiryText(exp) {
  if (!exp.hasExpiry) return "無期限";
  const date = new Date(exp.expiryMs).toLocaleDateString("ja-JP");
  return exp.expired ? `${date}（期限切れ）` : date;
}

function applyCardFilters() {
  const tbody = $("#cards-tbody");
  const neStatus = $("#cards-ne-select").value;               // "" or pending/submitting/...
  const batchId = $("#cards-lot-select").value;               // "" or batchId or LOT_NONE
  const expiryFilter = $("#cards-expiry-select").value;       // "" / "expired" / "near"
  const query = $("#cards-search").value;
  const typeName = (id) => findAnyType(id)?.name || id;

  const genFrom = $("#cards-gen-from").value;
  const genTo = $("#cards-gen-to").value;

  // ★現在モード（カタログ / クーポン）の kind だけに絞る（混在一覧をやめる）。
  //   kind 未設定の既存カードは catalog 扱い（後方互換）。
  const mk = modeKind();
  const modeCards = cardsCache.filter((c) => (c.kind ?? CARD_KIND.CATALOG) === mk);

  let rows = filterCards(modeCards, { neStatus, batchId, query });
  // 生成日の範囲（JST）で絞り込み。ロットが増えても期間指定で対象を絞れる。generatedAt 無しは範囲対象外。
  if (genFrom) rows = rows.filter((c) => { const d = cardGenDateJst(c); return d !== null && d >= genFrom; });
  if (genTo) rows = rows.filter((c) => { const d = cardGenDateJst(c); return d !== null && d <= genTo; });
  // 有効期限の絞り込みは種別デフォルトに依存するためクライアント側で（期限判定は共有モジュール）。
  if (expiryFilter === "expired") rows = rows.filter((c) => cardExpiry(c).expired);
  else if (expiryFilter === "near") rows = rows.filter((c) => { const v = cardExpiry(c); return !v.expired && v.near; });

  $("#cards-count").textContent = modeCards.length
    ? `${rows.length} / ${modeCards.length} 件`
    : "";

  tbody.innerHTML = "";
  if (rows.length === 0) {
    tableEmpty(tbody, 7, modeCards.length === 0
      ? "該当するカードがありません。"
      : "検索・絞り込み条件に一致するカードがありません。");
    return;
  }
  // 一覧は要点だけ（生成日/有効期限→状態→種別→受け取り者名→使用日時→memo→操作）。
  // トークン・受け取り者URL の全文は詳細ビューと「URLコピー」で参照できるよう一覧からは外す。
  for (const c of rows) {
    const url = receiveUrl(c.token, c.kind);
    const gen = c.generatedAt ? fmtDate(c.generatedAt) : "不明";
    const exp = cardExpiry(c);
    const expTxt = expiryText(exp);
    const expClass = exp.expired ? "expiry-over" : (exp.near ? "expiry-near" : "muted");
    const name = c.shippingAddress?.name || "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="small">
        <div title="生成日時: ${esc(gen)}">${esc(gen)}</div>
        <div class="small ${expClass}" title="有効期限: ${esc(expTxt)}">期限: ${esc(expTxt)}</div>
      </td>
      <td><span class="status-cell">${statusBadgeHtml(c, exp)}</span></td>
      <td class="ellip" title="${esc(typeName(c.cardTypeId))}">${esc(typeName(c.cardTypeId))}</td>
      <td class="ellip" title="${esc(name)}">${esc(name)}</td>
      <td class="small">${fmtDate(c.usedAt)}</td>
      <td><input class="memo-input" data-id="${c.id}" value="${esc(c.memo)}" placeholder="受注番号など"></td>
      <td>
        <div class="row-actions">
          <button data-act="detail" data-id="${c.id}">詳細</button>
          <button data-act="copy-url" data-url="${esc(url)}" title="受け取り者URLをコピー">URLコピー</button>
          <button data-act="save-memo" data-id="${c.id}">memo保存</button>
        </div>
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

/** クリップボードにコピー（成功/失敗をflashで通知）。一覧・詳細で共用。what はコピー対象の名称。 */
async function copyToClipboard(text, what = "URL") {
  try {
    await navigator.clipboard.writeText(text);
    flash(`${what}をコピーしました。`);
  } catch (_) {
    flash(`コピーに失敗しました。${what}を選択して手動でコピーしてください。`, "error");
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

/** 種別を catalog / coupon の両キャッシュから探す（表示用のフォールバック）。 */
function findAnyType(id) {
  return cardTypesCache.find((t) => t.id === id) || couponTypesCache.find((t) => t.id === id) || null;
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

  // ★kind=coupon はカタログとは別のクーポン専用ビューへ振り分ける（カタログ描画には一切触れない）。
  if ((card.kind ?? CARD_KIND.CATALOG) === CARD_KIND.COUPON) {
    body.innerHTML = couponDetailHtml(card);
    return;
  }

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
  const exp = cardExpiry(card);

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
      ${addrRow("生成日時", card.generatedAt ? fmtDate(card.generatedAt) : "不明")}
      ${card.batchId ? addrRow("ロットID", card.batchId) : ""}
      ${addrRow("有効期限", expiryText(exp))}
      ${exp.hasExpiry && !exp.expired ? addrRow("期限まで", `残り ${exp.remainingDays} 日`) : ""}
      ${card.expiryDaysOverride ? addrRow("期限の個別上書き", `${card.expiryDaysOverride} 日`) : ""}
      <div class="detail-row">
        <span class="detail-label">状態</span>
        <span class="detail-value status-cell">${statusBadgeHtml(card, exp)}</span>
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
    </section>

    <section class="detail-section">
      <h3>有効期限の管理（延長・上書き）</h3>
      <p class="muted small">個別に有効期限日数を上書きします（種別デフォルトより優先）。空欄で保存すると上書き解除（種別デフォルト／無期限に戻る）。<strong>期限切れカードもここで延長すれば再び受け取り可能</strong>になります。</p>
      <div class="edit-form">
        <label>上書き日数（空欄＝解除）
          <input id="detail-expiry" type="number" min="1" step="1" value="${card.expiryDaysOverride ?? ""}" placeholder="例: 120">
        </label>
      </div>
      <div><button data-act="expiry-save" type="button">有効期限を保存</button></div>
    </section>

    ${used ? neSubmitSectionHtml(card) : ""}

    ${used ? `<section class="detail-section">
      <h3>管理者操作</h3>
      ${neWarnHtml(card)}
      <div class="detail-ops">
        <button data-act="card-edit" type="button">受注内容を編集</button>
        <button data-act="card-reset" type="button" class="danger-btn">未使用に戻す（受け取り者に再入力させる）</button>
      </div>
    </section>` : ""}

    ${historyHtml(card)}`;
}

/**
 * クーポンカード（kind=coupon）専用の詳細ビュー。
 * カタログの受注詳細とは別物：商品/住所/NEは無く、クーポン発行状態・コード・手動発行/再発行ボタン・
 * MakeShop 生レスポンス表示（デバッグ用）を出す。恒久機能として失敗カードの手動再発行にも使う。
 */
function couponDetailHtml(card) {
  const type = findAnyType(card.cardTypeId);
  const exp = cardExpiry(card);
  const url = receiveUrl(card.token, CARD_KIND.COUPON);
  const cs = couponStatusInfo(card);
  const issued = card.couponStatus === COUPON_STATUS.ISSUED;
  const issuing = card.couponStatus === COUPON_STATUS.ISSUING;
  const discount = type?.couponConfig ? couponDiscountText(type.couponConfig) : "";

  const codeBlock = card.couponCode
    ? `<div class="detail-row"><span class="detail-label">クーポンコード</span>
         <span class="detail-value mono">${esc(card.couponCode)}
           <button class="copy-btn" type="button" data-act="coupon-copy-code" data-code="${esc(card.couponCode)}">コピー</button>
         </span></div>`
    : "";
  const errBlock = card.couponLastError
    ? `<div class="ne-warn">⚠ 直近の発行エラー: ${esc(card.couponLastError)}</div>` : "";

  let action, note;
  if (issuing) {
    action = "";
    note = `<p class="muted small">発行処理中の状態です。少し待ってから詳細を開き直してください。</p>`;
  } else if (issued) {
    // 発行済みでも管理者は再発行できる（MakeShop に別クーポンが作られる）。目立つ危険色＋警告確認。
    action = `<div class="detail-ops"><button data-act="coupon-issue" type="button" class="danger-btn">クーポンを再発行</button></div>`;
    note = `<p class="muted small">発行済みです。<strong>再発行</strong>すると MakeShop 側に<strong>別のクーポン</strong>が作られ、
      表示コードは新しいものに置き換わります（名前に【再発行 M/D】が付きます）。トラブル対応など必要な場合のみ実行してください。</p>`;
  } else {
    // 未発行（初回 or 発行失敗）。管理画面からの手動発行。
    const label = card.couponLastError ? "クーポンを再発行" : "クーポンを発行";
    action = `<div class="detail-ops"><button data-act="coupon-issue" type="button">${label}</button></div>`;
    note = `<p class="muted small">押すと<strong>実際に MakeShop へクーポンを1件発行</strong>します（確認ダイアログあり）。
      管理画面からの手動発行は名前に<strong>【再発行 M/D】</strong>が付きます。成功なら発行コードを表示、失敗なら MakeShop の応答（raw）を表示します。</p>`;
  }

  return `
    <section class="detail-section">
      <h3>クーポンカード</h3>
      ${addrRow("種別", type ? `${type.name}${discount ? `（${discount}）` : ""}` : card.cardTypeId)}
      ${addrRow("トークン", card.token)}
      ${addrRow("生成日時", card.generatedAt ? fmtDate(card.generatedAt) : "不明")}
      ${card.batchId ? addrRow("ロットID", card.batchId) : ""}
      ${addrRow("クーポン有効期限", card.couponExpiryAt ? fmtDate(card.couponExpiryAt) : "未設定")}
      ${exp.hasExpiry && !exp.expired ? addrRow("期限まで", `残り ${exp.remainingDays} 日`) : ""}
      <div class="detail-row">
        <span class="detail-label">状態</span>
        <span class="detail-value status-cell">${statusBadgeHtml(card, exp)}</span>
      </div>
      ${issued ? addrRow("発行日時", fmtDate(card.couponIssuedAt)) : ""}
    </section>

    <section class="detail-section">
      <h3>受け取り者（株主）用URL</h3>
      <div class="url-cell">
        <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>
        <button class="copy-btn" type="button" data-act="detail-copy-url" data-url="${esc(url)}">コピー</button>
      </div>
    </section>

    <section class="detail-section">
      <h3>クーポン発行</h3>
      <div class="detail-row">
        <span class="detail-label">現在の状態</span>
        <span class="detail-value status-cell"><span class="badge badge-${cs.kind}">${cs.label}</span></span>
      </div>
      ${codeBlock}
      ${errBlock}
      ${note}
      ${action}
      <div class="detail-ops">
        <button data-act="coupon-introspect" type="button" class="ghost">スキーマ診断</button>
      </div>
      <p class="muted small">「スキーマ診断」は MakeShop の実スキーマ（CreateCouponRequest のフィールド名・enum値・結果型）を取得して下に表示します（クーポンは発行しません）。<strong>MakeShop がクーポンAPIの仕様を変更して発行が失敗するようになった際の切り分けに使う運用ツール</strong>です（introspection は本番で無効なため、変更内容はここで確認します）。</p>
      <div id="coupon-result" class="coupon-result"></div>
    </section>

    <section class="detail-section">
      <h3>memo（管理者記入欄）</h3>
      <textarea id="detail-memo" class="detail-memo" rows="2" placeholder="受注番号など突合用">${esc(card.memo)}</textarea>
      <div><button id="detail-memo-save" type="button">memoを保存</button></div>
    </section>`;
}

/**
 * 詳細ビューの「ネクストエンジン投入」セクション（使用済みカードのみ）。
 * 非同期キューのため、状態に応じてボタンの意味が変わる:
 *   pending/未投入 → 「NEへ手動投入」（確認ダイアログ。押すと queued へ）
 *   queued        → 「取り込み結果を確認」（que_id を照会し submitted / pending を確定）
 *   submitting    → 処理中表示（ボタンなし）
 *   submitted/csv → 投入済み表示（再投入は『未使用に戻す』でやり直す旨を案内。二重投入防止）
 * neLastError（直近の失敗理由）・que_id・投入完了日時も表示して、管理者が原因を追えるようにする。
 */
function neSubmitSectionHtml(card) {
  const st = card.neStatus;
  const ne = neStatusInfo(st);
  const isQueued = st === NE_STATUS.QUEUED;
  const isSubmitting = st === NE_STATUS.SUBMITTING;
  const isSent = st === NE_STATUS.SUBMITTED || st === NE_STATUS.CSV_EXPORTED;

  const errHtml = card.neLastError
    ? `<div class="ne-warn">⚠ 直近の投入エラー: ${esc(card.neLastError)}</div>` : "";
  const queRow = card.neQueId ? addrRow("キューID（que_id）", card.neQueId) : "";
  const submittedRow = card.neSubmittedAt ? addrRow("投入完了日時", fmtDate(card.neSubmittedAt)) : "";

  let action, note;
  if (isSent) {
    action = "";
    note = `<p class="muted small">このカードは既にネクストエンジンに投入済みです。再投入が必要な場合は
      「未使用に戻す」で受注をやり直してください（二重投入防止のため、ここからは再投入できません）。</p>`;
  } else if (isSubmitting) {
    action = "";
    note = `<p class="muted small">投入処理中です。少し待ってから詳細を開き直してください。</p>`;
  } else if (isQueued) {
    action = `<div class="detail-ops"><button data-act="ne-manual-submit" type="button">取り込み結果を確認</button></div>`;
    note = `<p class="muted small">アップロードは受付済み（キュー）です。<strong>「取り込み結果を確認」</strong>を押すと
      que_id を照会し、成功なら「NE投入済」、失敗なら「未投入」に戻して原因を表示します（数十秒待ってから押してください）。</p>`;
  } else {
    // pending / error / 未設定
    action = `<div class="detail-ops"><button data-act="ne-manual-submit" type="button">NEへ手動投入</button></div>`;
    note = `<p class="muted small">押すと店舗2（パターン11）へ投入します。<strong>非同期のため1回目は「受付済」</strong>になり、
      もう一度「取り込み結果を確認」を押すと投入完了/失敗が確定します。</p>`;
  }

  return `<section class="detail-section">
    <h3>ネクストエンジン投入</h3>
    <div class="detail-row">
      <span class="detail-label">現在の状態</span>
      <span class="detail-value status-cell"><span class="badge badge-${ne.kind}">${ne.label}</span></span>
    </div>
    ${queRow}${submittedRow}${errHtml}
    ${note}
    ${action}
  </section>`;
}

// NE 投入済み（投入済/CSV出力済/投入中）とみなす状態。編集・やり直し時に警告を出す対象。
const NE_SENT = new Set([NE_STATUS.SUBMITTED, NE_STATUS.CSV_EXPORTED, NE_STATUS.SUBMITTING]);
/** カードが NE 投入済みかどうか（編集・やり直しで警告する判定）。 */
function isNeSent(card) {
  return NE_SENT.has(card.neStatus);
}
/** NE 投入済みカードの警告バナー（未投入なら空）。 */
function neWarnHtml(card) {
  if (!isNeSent(card)) return "";
  return `<div class="ne-warn">⚠ このカードは既にネクストエンジンに投入済みです。編集／やり直しをしても、
    NE側の受注は自動では更新されません。NE側も手動で修正してください。</div>`;
}
/** 過去の入力履歴（previousSubmissions）の表示。無ければ空。 */
function historyHtml(card) {
  const hist = Array.isArray(card.previousSubmissions) ? card.previousSubmissions : [];
  if (!hist.length) return "";
  // 新しい履歴を上に。
  const rows = [...hist].reverse().map((h, idx) => {
    const a = h.shippingAddress || {};
    return `<div class="history-item">
      <div class="history-head">#${hist.length - idx}　戻した日時: ${esc(fmtDate(h.resetAt))}${h.resetBy ? `（${esc(h.resetBy)}）` : ""}</div>
      ${addrRow("確定日時", fmtDate(h.usedAt))}
      ${addrRow("氏名", a.name)}
      ${addrRow("メール", h.recipientEmail)}
      ${addrRow("商品ID", h.selectedProductId)}
      ${addrRow("配達希望", [h.deliveryDate, h.deliveryTime].filter(Boolean).join(" ") || "指定なし")}
      ${addrRow("戻す前のNE状態", h.neStatus ? neStatusInfo(h.neStatus).label : "")}
    </div>`;
  }).join("");
  return `<section class="detail-section">
    <h3>過去の入力履歴（${hist.length}件）</h3>
    ${rows}
  </section>`;
}

/** 詳細モーダルを閉じる。 */
function closeCardDetail() {
  $("#detail-overlay").hidden = true;
  detailCardId = null;
}

/** 詳細モーダル内のクリック（コピー・memo保存・編集・やり直し）。 */
async function onDetailClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "detail-copy-url") {
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
    return;
  }
  if (act === "card-edit") { await openCardEditForm(); return; }
  if (act === "edit-cancel") { openCardDetail(detailCardId); return; }
  if (act === "edit-save") { await onEditSave(btn); return; }
  if (act === "card-reset") { await onCardReset(btn); return; }
  if (act === "expiry-save") { await onExpirySave(btn); return; }
  if (act === "ne-manual-submit") { await onManualSubmitNe(btn); return; }
  if (act === "coupon-issue") { await onIssueCoupon(btn); return; }
  if (act === "coupon-copy-code") { await copyToClipboard(btn.dataset.code, "クーポンコード"); return; }
  if (act === "coupon-introspect") { await onIntrospectSchema(btn); return; }
  if (act === "coupon-copy-raw") { await copyToClipboard(lastCouponRawJson, "raw"); return; }
}

/**
 * MakeShop の実スキーマを取得して結果欄に表示する（スキーマ診断・恒久の運用ツール）。
 * adminTestIssueCoupon の introspect モードを叩く（クーポンは発行しない）。
 * MakeShop がAPI仕様を変更して発行が失敗した際、変更後のフィールド名・enum値・結果型を確認して
 * 送信フィールド（makeshop/coupon.ts）を合わせるための切り分けに使う。introspection は本番で無効なため本ツールで取得する。
 */
async function onIntrospectSchema(btn) {
  const resultEl = $("#coupon-result");
  btn.disabled = true;
  if (resultEl) resultEl.innerHTML = `<div class="loading-cell">${SPINNER}スキーマ取得中…</div>`;
  try {
    const res = await authorizedFetch("/api/adminTestIssueCoupon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ introspect: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      renderCouponResult(resultEl, { error: data?.message || data?.code || `HTTP ${res.status}`, raw: data });
      flash("スキーマ取得に失敗しました。", "error");
      return;
    }
    renderCouponResult(resultEl, { raw: data.raw });
    flash("スキーマを取得しました。「コピー」で全文をコピーして共有してください。");
  } catch (err) {
    renderCouponResult(resultEl, { error: err?.message || String(err) });
    flash(`スキーマ取得に失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

/**
 * クーポンを手動（再）発行（詳細ビュー・単一カード）。adminTestIssueCoupon を叩く。
 * 実際に MakeShop へ発行されるため確認ダイアログを挟む。結果（成功コード or 失敗の raw）を
 * モーダル内 #coupon-result にそのまま表示する（スキーマ調整のため raw を見せることが重要）。
 * ※詳細は開き直さない（raw を消さないため）。一覧のバッジだけ裏で最新化する。
 */
async function onIssueCoupon(btn) {
  const id = detailCardId;
  if (!id) return;
  const card = cardsCache.find((c) => c.id === id);
  if (!card) return;
  // 発行済みカードの再発行は、別クーポンが作られる旨を明示して確認する。
  const isReissue = card.couponStatus === COUPON_STATUS.ISSUED;
  const msg = isReissue
    ? "既にクーポン発行済みです。再発行しますか？\nMakeShop 側に別のクーポンが作られ、表示コードは新しいものに置き換わります（名前に【再発行 M/D】が付きます）。"
    : "実際に MakeShop へクーポンを1件発行します。よろしいですか？\n（管理画面からの手動発行は名前に【再発行 M/D】が付きます）";
  if (!confirm(msg)) return;

  const resultEl = $("#coupon-result");
  btn.disabled = true;
  if (resultEl) resultEl.innerHTML = `<div class="loading-cell">${SPINNER}発行しています…</div>`;
  try {
    const res = await authorizedFetch("/api/adminTestIssueCoupon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      // makeshop_not_configured / 認証エラー等。message/code をそのまま見せる。
      renderCouponResult(resultEl, { error: data?.message || data?.code || `HTTP ${res.status}`, raw: data });
      flash(`発行に失敗しました: ${data?.message || data?.code || res.status}`, "error");
      return;
    }
    renderCouponResult(resultEl, data); // { result, couponCode, error, reason, raw }
    if (data.result === "issued") flash(`クーポンを発行しました: ${data.couponCode || ""}`);
    else if (data.result === "failed") flash(`発行失敗: ${data.error || ""}`, "error");
    else flash(`スキップ: ${data.reason || ""}`, "error");
    // 一覧のバッジを裏で最新化（詳細は開き直さず raw を残す）。
    const fresh = await getCard(id);
    const i = cardsCache.findIndex((c) => c.id === id);
    if (fresh && i >= 0) { cardsCache[i] = fresh; applyCardFilters(); }
  } catch (err) {
    renderCouponResult(resultEl, { error: err?.message || String(err) });
    flash(`発行に失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

// 直近に表示した raw（生レスポンス／スキーマ）のJSON文字列。「コピー」ボタンで全文コピーするため保持。
let lastCouponRawJson = "";

/** 手動発行/スキーマ診断の結果（成功コード／失敗理由／MakeShop 生レスポンス raw）をモーダル内に表示する。 */
function renderCouponResult(el, data) {
  if (!el) return;
  const parts = [];
  if (data.result === "issued" || data.couponCode) {
    parts.push(`<div class="ok-msg">✅ 発行成功：<strong class="mono">${esc(data.couponCode || "")}</strong></div>`);
  }
  if (data.error || data.result === "failed") {
    parts.push(`<div class="ne-warn">⚠ 発行失敗：${esc(data.error || "")}</div>`);
  }
  if (data.reason && data.result === "skipped") {
    parts.push(`<div class="muted">スキップ：${esc(data.reason)}</div>`);
  }
  if (data.raw !== undefined) {
    lastCouponRawJson = JSON.stringify(data.raw, null, 2);
    parts.push(`<div class="muted small">MakeShop 生レスポンス（raw）:
      <button type="button" class="copy-btn" data-act="coupon-copy-raw">コピー</button></div>`);
    parts.push(`<pre class="coupon-raw">${esc(lastCouponRawJson)}</pre>`);
  }
  el.innerHTML = parts.join("");
}

/** ネクストエンジンへの手動投入 / 取り込み結果確認（詳細ビュー・単一カード）。 */
async function onManualSubmitNe(btn) {
  const id = detailCardId;
  if (!id) return;
  const card = cardsCache.find((c) => c.id === id);
  if (!card) return;
  const isQueued = card.neStatus === NE_STATUS.QUEUED;

  // 初回投入（pending 等）のときだけ確認ダイアログ。queued の結果確認は状態照会なので確認不要。
  if (!isQueued) {
    if (card.neStatus === NE_STATUS.SUBMITTED || card.neStatus === NE_STATUS.CSV_EXPORTED) {
      flash("このカードは既にNE投入済みです（二重投入防止）。", "error");
      return;
    }
    if (!confirm("このカードをネクストエンジン（店舗2・パターン11）に投入します。よろしいですか？")) return;
  }

  btn.disabled = true;
  try {
    const res = await authorizedFetch(`/api/adminRetryNeSubmissions?cardId=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data?.code || `HTTP ${res.status}`);
    if (!data.configured) {
      flash("NE投入は有効になっていません（NE_MODE=csv、またはパターンID未設定）。", "error");
      btn.disabled = false;
      return;
    }
    flash(neManualResultMsg(data), data.failed ? "error" : "info");
    await refreshDetailCard(id); // 詳細を取り直して neStatus / neLastError / que_id を最新化。
  } catch (err) {
    flash(`NE投入に失敗しました: ${err?.message || err}`, "error");
    btn.disabled = false;
  }
}

/** 手動投入APIの結果（1件）を管理者向けメッセージに。 */
function neManualResultMsg(d) {
  if (d.submitted) return "取り込み成功：NEに投入済みになりました。";
  if (d.queued) return "キューに受付されました（受付済）。数十秒後に「取り込み結果を確認」を押してください。";
  if (d.failed) return "投入に失敗しました。「直近の投入エラー」をご確認ください（未投入に戻しました）。";
  if (d.waiting) return "まだ取り込み処理中です。少し待って「取り込み結果を確認」を押してください。";
  return "対象外でした（状態が既に変化している可能性があります）。";
}

/** 有効期限の個別上書き保存（確認ダイアログ → adminSetCardExpiry）。期限切れの延長にも使う。 */
async function onExpirySave(btn) {
  const id = detailCardId;
  if (!id) return;
  const raw = $("#detail-expiry").value.trim();
  const days = raw === "" ? null : Number(raw);
  if (raw !== "" && (!Number.isInteger(days) || days <= 0)) {
    return flash("上書き日数は1以上の整数、または空欄にしてください。", "error");
  }
  const msg = raw === ""
    ? "有効期限の個別上書きを解除しますか？（種別デフォルト／無期限に戻ります）"
    : `有効期限の個別上書きを「生成日から ${days} 日」に設定しますか？`;
  if (!confirm(msg)) return;
  btn.disabled = true;
  try {
    const res = await authorizedFetch("/api/adminSetCardExpiry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: id, expiryDaysOverride: raw === "" ? null : days }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(editErrorMessage(data.code, res.status));
    flash("有効期限を更新しました。");
    await refreshDetailCard(id);
  } catch (err) {
    flash(`有効期限の更新に失敗しました: ${err?.message || err}`, "error");
    btn.disabled = false;
  }
}

// ===== 管理者による受注編集・やり直し =====
// クライアント側の軽い事前チェック（本チェックはサーバの order-fields.ts で確実に行う）。
const KANA_RE_ADMIN = /^[゠-ヿ　\s]+$/;
const EMAIL_RE_ADMIN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 配達希望日の選択可能範囲（今日基準。受け取り者フォームと同じ）。 */
function adminDeliveryBounds() {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const min = new Date(); min.setDate(min.getDate() + DELIVERY.MIN_DAYS);
  const max = new Date(); max.setMonth(max.getMonth() + DELIVERY.MAX_MONTHS);
  return { min: ymd(min), max: ymd(max) };
}

/** 詳細モーダルを編集フォームに切り替える（現在の detailCardId のカードを編集）。 */
async function openCardEditForm() {
  const card = cardsCache.find((c) => c.id === detailCardId);
  if (!card) return;
  const body = $("#detail-body");
  body.innerHTML = `<div class="loading-cell">${SPINNER}読み込み中…</div>`;
  // 種別に紐づく商品を選択肢に（種別をまたがない）。
  let products = [];
  try { products = await listProductsByType(card.cardTypeId); } catch (_) { /* 空で続行 */ }
  if (detailCardId !== card.id) return;

  const a = card.shippingAddress || {};
  const { min, max } = adminDeliveryBounds();
  const prodOptions = products.map((p) =>
    `<option value="${esc(p.id)}"${p.id === card.selectedProductId ? " selected" : ""}>${esc(p.name)}${p.active ? "" : "（無効）"}</option>`).join("");
  const prefOptions = `<option value="">選択してください</option>` +
    PREFECTURES.map((pr) => `<option value="${esc(pr)}"${pr === a.prefecture ? " selected" : ""}>${esc(pr)}</option>`).join("");
  const timeOptions = `<option value="">指定なし</option>` +
    DELIVERY.TIME_SLOTS.map((s) => `<option value="${esc(s)}"${s === card.deliveryTime ? " selected" : ""}>${esc(s)}</option>`).join("");

  body.innerHTML = `
    <section class="detail-section">
      <h3>受注内容の編集</h3>
      ${neWarnHtml(card)}
      <div class="edit-form">
        <label>選択商品<select id="edit-product">${prodOptions}</select></label>
        <label>氏名<input id="edit-name" type="text" value="${esc(a.name)}"></label>
        <label>氏名カナ<input id="edit-kana" type="text" value="${esc(a.nameKana)}"></label>
        <label>メールアドレス<input id="edit-email" type="email" value="${esc(card.recipientEmail)}"></label>
        <label>郵便番号<input id="edit-postal" type="text" inputmode="numeric" value="${esc(a.postalCode)}"></label>
        <label>都道府県<select id="edit-prefecture">${prefOptions}</select></label>
        <label>住所（市区町村・番地）<input id="edit-address" type="text" value="${esc(a.address)}"></label>
        <label>建物名・部屋番号<input id="edit-building" type="text" value="${esc(a.building)}"></label>
        <label>電話番号<input id="edit-phone" type="tel" value="${esc(a.phone)}"></label>
        <label>配達希望日<input id="edit-delivery-date" type="date" min="${min}" max="${max}" value="${esc(card.deliveryDate)}"></label>
        <label>配達希望時間帯<select id="edit-delivery-time">${timeOptions}</select></label>
      </div>
      <div class="detail-ops">
        <button data-act="edit-save" type="button">保存する</button>
        <button data-act="edit-cancel" type="button" class="ghost">キャンセル</button>
      </div>
    </section>`;
}

/** 編集フォームの保存（確認ダイアログ → adminUpdateGiftCard）。 */
async function onEditSave(btn) {
  const id = detailCardId;
  const card = cardsCache.find((c) => c.id === id);
  if (!card) return;
  const val = (sel) => $(sel).value.trim();
  const shippingAddress = {
    name: val("#edit-name"), nameKana: val("#edit-kana"), postalCode: val("#edit-postal"),
    prefecture: val("#edit-prefecture"), address: val("#edit-address"),
    building: val("#edit-building"), phone: val("#edit-phone"),
  };
  const selectedProductId = val("#edit-product");
  const email = val("#edit-email");
  const deliveryDate = val("#edit-delivery-date");
  const deliveryTime = val("#edit-delivery-time");

  // 軽い事前チェック（本番はサーバで検証）。
  if (!selectedProductId) return flash("商品を選択してください。", "error");
  if (!shippingAddress.name || !shippingAddress.postalCode || !shippingAddress.prefecture
      || !shippingAddress.address || !shippingAddress.phone) return flash("必須項目を入力してください。", "error");
  if (!KANA_RE_ADMIN.test(shippingAddress.nameKana)) return flash("氏名カナは全角カナで入力してください。", "error");
  if (!EMAIL_RE_ADMIN.test(email)) return flash("メールアドレスの形式をご確認ください。", "error");
  if (deliveryDate) {
    const { min, max } = adminDeliveryBounds();
    if (deliveryDate < min || deliveryDate > max) return flash("配達希望日は指定できる範囲外です。", "error");
  }

  const warn = isNeSent(card) ? "\n\n※このカードはNE投入済みです。NE側は自動更新されないため手動で修正してください。" : "";
  if (!confirm(`この内容で保存しますか？${warn}`)) return;

  btn.disabled = true;
  try {
    const res = await authorizedFetch("/api/adminUpdateGiftCard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: id, selectedProductId, shippingAddress, email, deliveryDate, deliveryTime }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(editErrorMessage(data.code, res.status));
    flash("受注内容を保存しました。");
    await refreshDetailCard(id);
  } catch (err) {
    flash(`保存に失敗しました: ${err?.message || err}`, "error");
    btn.disabled = false;
  }
}

/** 使用済み→未使用へ戻す（確認ダイアログ → adminResetGiftCard）。 */
async function onCardReset(btn) {
  const id = detailCardId;
  const card = cardsCache.find((c) => c.id === id);
  if (!card) return;
  const warn = isNeSent(card) ? "\n\n※このカードはNE投入済みです。NE側は自動更新されないため手動で修正してください。" : "";
  if (!confirm(`このカードを未使用に戻しますか？現在の入力は履歴として残り、受け取り者が同じURLから再入力できるようになります。${warn}`)) return;

  btn.disabled = true;
  try {
    const res = await authorizedFetch("/api/adminResetGiftCard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(editErrorMessage(data.code, res.status));
    flash("未使用に戻しました。履歴を保存しました。");
    await refreshDetailCard(id);
  } catch (err) {
    flash(`やり直しに失敗しました: ${err?.message || err}`, "error");
    btn.disabled = false;
  }
}

/** 編集・やり直しのエラーコードを日本語に。 */
function editErrorMessage(code, status) {
  return ({
    invalid_address: "住所・カナの入力をご確認ください。",
    invalid_email: "メールアドレスの形式をご確認ください。",
    invalid_delivery_date: "配達希望日が範囲外です。",
    invalid_delivery_time: "配達希望時間帯が不正です。",
    invalid_product: "選択商品が不正です（種別違い等）。",
    not_used: "このカードは使用済みではありません。",
    not_found: "カードが見つかりません。",
  })[code] || `HTTP ${status}`;
}

/** 編集・やり直し後にカードを取り直して、詳細ビューと一覧を最新化する。 */
async function refreshDetailCard(id) {
  const fresh = await getCard(id);
  const i = cardsCache.findIndex((c) => c.id === id);
  if (fresh && i >= 0) cardsCache[i] = fresh;
  applyCardFilters();          // 一覧の状態バッジ等を更新。
  if (detailCardId === id) openCardDetail(id); // 詳細を読み取りビューへ戻す。
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
    a.download = "ne-orders-shop2.csv"; // 店舗2の受注一括登録パターンで取り込む運用を明示。
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
      ? `投入済 ${data.submitted ?? 0} / 受付済 ${data.queued ?? 0} / 確認待ち ${data.waiting ?? 0} / 失敗 ${data.failed ?? 0} / 対象外 ${data.skipped ?? 0}`
      : "NE投入は未設定です（CSV運用中）。対象0件。");
  } catch (err) {
    busyDone($("#ne-result"));
    flash(`リトライに失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

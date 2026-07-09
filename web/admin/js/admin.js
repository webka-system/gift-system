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
  listCards, updateCardMemo, getProductById, getCard, deleteField, CARD_STATUS,
} from "./db.js";
import { uploadProductImage } from "./storage.js";
import { neStatusInfo, statusBadgeHtml } from "./status.js";
import { filterCards, LOT_NONE } from "./cards-filter.js";
import { TOKEN, PRODUCT, PREFECTURES, DELIVERY, NE_STATUS } from "/shared/constants.js";
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
  if (tab === "print") { await refreshTypes(); return populatePrintLots(); }
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
      <td>
        <div class="row-actions">
          <button data-act="toggle" data-id="${t.id}">${t.active ? "無効化" : "有効化"}</button>
          <button data-act="edit" data-id="${t.id}">編集</button>
        </div>
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
    $("#type-expiry").value = t.expiryDays ?? "";
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

  // QR一覧フィルタ。種別・状態はサーバ再取得、NE投入状態・検索はクライアント側でリアルタイム絞り込み。
  $("#cards-type-select").addEventListener("change", renderCards);
  $("#cards-status-select").addEventListener("change", renderCards);
  $("#cards-ne-select").addEventListener("change", applyCardFilters);
  $("#cards-lot-select").addEventListener("change", applyCardFilters);
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
    const typeId = $("#print-type-select").value;
    if (typeId) params.set("cardTypeId", typeId);
    const lot = $("#print-lot-select").value;
    if (lot) params.set("batchId", lot);
    const genDate = $("#print-gen-date").value;
    if (genDate) params.set("generatedDate", genDate);
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
  populateLotFilter();
  applyCardFilters();
}

/**
 * ロット（生成バッチ）絞り込みの <option> HTML を、カード配列から組み立てる。
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
  let html = `<option value="">すべて</option>`;
  for (const [batchId, e] of entries) {
    html += `<option value="${esc(batchId)}">${esc(fmtDate(e.generatedAt) || "不明")}（${e.count}枚）</option>`;
  }
  if (noneCount) html += `<option value="${LOT_NONE}">生成日時不明（${noneCount}枚）</option>`;
  return html;
}

/** QR一覧のロット絞り込みを取得済みカードから最新化する。 */
function populateLotFilter() {
  const sel = $("#cards-lot-select");
  const prev = sel.value;
  sel.innerHTML = lotOptionsHtml(cardsCache);
  if (prev) sel.value = prev;
}

/** 印刷タブのロット絞り込みを、選択中の種別のカードから組み立てる。 */
async function populatePrintLots() {
  const sel = $("#print-lot-select");
  if (!sel) return;
  const prev = sel.value;
  const cardTypeId = $("#print-type-select").value || undefined;
  let cards = [];
  try { cards = await listCards({ cardTypeId }); } catch (_) { /* 空で続行 */ }
  sel.innerHTML = lotOptionsHtml(cards);
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
/** カードの有効期限判定（種別デフォルト＋個別上書き＋現在時刻）。cardTypesCache を参照。 */
function cardExpiry(c) {
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
  const typeName = (id) => cardTypesCache.find((t) => t.id === id)?.name || id;

  let rows = filterCards(cardsCache, { neStatus, batchId, query });
  // 有効期限の絞り込みは種別デフォルトに依存するためクライアント側で（期限判定は共有モジュール）。
  if (expiryFilter === "expired") rows = rows.filter((c) => cardExpiry(c).expired);
  else if (expiryFilter === "near") rows = rows.filter((c) => { const v = cardExpiry(c); return !v.expired && v.near; });

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
  // 一覧は要点だけ（生成日/有効期限→状態→種別→受け取り者名→使用日時→memo→操作）。
  // トークン・受け取り者URL の全文は詳細ビューと「URLコピー」で参照できるよう一覧からは外す。
  for (const c of rows) {
    const url = receiveUrl(c.token);
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
      ? `投入済 ${data.submitted} / 失敗 ${data.failed} / 対象外 ${data.skipped}`
      : "自動投入は未設定です（CSV運用中）。対象0件。");
  } catch (err) {
    busyDone($("#ne-result"));
    flash(`リトライに失敗しました: ${err?.message || err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

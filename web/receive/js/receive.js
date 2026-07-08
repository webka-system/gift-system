/*
 * 受け取り者画面コントローラ（design.md 4.2）
 *
 * ログイン不要・トークンURL /g/<token> で着地する。すべての読み書きは Cloud Functions 経由
 * （クライアント直Firestoreアクセスは禁止 / design.md 第8章）。Firebase SDK は読み込まない。
 *
 * フロー: トークン照合 → 商品ラインナップ表示 → 商品1つ選択 → 住所入力 → 確定 → 完了画面。
 * 使用済みトークンは「使用済み」表示（二重利用防止）。
 */

const $ = (sel, root = document) => root.querySelector(sel);

/** HTMLエスケープ（商品名・説明の表示時XSS対策）。 */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
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
  const shippingAddress = {
    name: (fd.get("name") || "").trim(),
    postalCode: (fd.get("postalCode") || "").trim(),
    prefecture: (fd.get("prefecture") || "").trim(),
    address: (fd.get("address") || "").trim(),
    building: (fd.get("building") || "").trim(),
    phone: (fd.get("phone") || "").trim(),
  };

  const btn = $("#confirm-btn");
  btn.disabled = true;
  btn.textContent = "送信中…";
  try {
    const res = await fetch("/api/receiveConfirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, selectedProductId, shippingAddress }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) { show("view-done"); return; }

    // 同時確定・再確定は「使用済み」表示に倒す（二重利用防止）。
    if (res.status === 409) { show("view-used"); return; }
    if (res.status === 404) { show("view-invalid"); return; }

    // それ以外（住所不備・商品不正・通信）は同画面でエラー表示。
    err.textContent = data.code === "invalid_address"
      ? "お届け先の入力に不足があります。必須項目をご確認ください。"
      : data.code === "invalid_product"
        ? "選択された商品が無効です。お手数ですが選び直してください。"
        : "送信に失敗しました。時間をおいて再度お試しください。";
    err.hidden = false;
  } catch (_) {
    err.textContent = "通信に失敗しました。接続をご確認ください。";
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "この内容で確定する";
  }
});

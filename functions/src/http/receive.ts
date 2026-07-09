/**
 * 受け取り者API（design.md 4.2 / 第9章 手順5）
 *
 * 受け取り者フローは **全面 Cloud Functions 経由**。トークン照合・確定・使用済み化をサーバ側で行い、
 * クライアントからの Firestore 直アクセスは禁止のまま（firestore.rules は受け取り者向けの口を開けない）。
 * トークンが唯一の外部アクセス制御（design.md 第8章）。
 *
 * エンドポイント:
 *   - GET  /api/receiveGetCard?token=...   … トークンでカードを引き、状態＋商品ラインナップを返す。
 *   - POST /api/receiveConfirm             … 商品選択＋住所を受け、トランザクションで確定・使用済み化。
 *
 * NE投入は第6ステップ本体で実装。第5では確定時に neStatus:"pending"（未投入）を記録するのみ（スタブ）。
 */

import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { CARD_STATUS, NE_STATUS, DELIVERY } from "../config/constants";
import { HTTP_OPTIONS } from "./options";
import { db, giftCardsRef, giftCardTypesRef, selectableProductsRef } from "../lib/firestore";
import { ShippingAddress } from "../models";
import { applyCors } from "./cors";

// 全角カナ（カタカナブロック U+30A0–30FF ＋全角スペース U+3000 ＋半角空白）。氏名カナの形式チェック用。
const KANA_RE = /^[゠-ヿ\u3000\s]+$/;
// 簡易メール形式（前後空白なし・@・ドメインにドット）。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// クライアントの日付操作を信用しないためのサーバ側 JST 基準。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ざっくりした業務エラー（HTTPステータスへマップする）。
class ReceiveError extends Error {
  constructor(public httpStatus: number, public code: string) {
    super(code);
  }
}

// クエリ or ボディからトークンを取り出す。
function tokenOf(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

// 配送先住所の検証。必須文字列が揃っているかを確認し、正規化して返す。
function validateAddress(raw: unknown): ShippingAddress {
  const a = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const addr: ShippingAddress = {
    name: str(a.name),
    nameKana: str(a.nameKana),
    postalCode: str(a.postalCode),
    prefecture: str(a.prefecture),
    address: str(a.address),
    phone: str(a.phone),
  };
  // building は任意。空なら **フィールド自体を付けない**（undefined を Firestore に書くとエラーになるため）。
  const building = str(a.building);
  if (building) addr.building = building;
  // building 以外は必須。
  if (!addr.name || !addr.nameKana || !addr.postalCode || !addr.prefecture || !addr.address || !addr.phone) {
    throw new ReceiveError(400, "invalid_address");
  }
  // 氏名カナは全角カナ形式（NEの受注名カナ／発送先カナに必要）。
  if (!KANA_RE.test(addr.nameKana)) {
    throw new ReceiveError(400, "invalid_address");
  }
  return addr;
}

// メールアドレスの検証（必須＋形式＋確認一致）。NEの受注メールアドレス（通知宛先）になる。
function validateEmail(rawEmail: unknown, rawConfirm: unknown): string {
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const confirm = typeof rawConfirm === "string" ? rawConfirm.trim() : "";
  if (!EMAIL_RE.test(email) || email !== confirm) {
    throw new ReceiveError(400, "invalid_email");
  }
  return email;
}

// 指定日を UTC の日付のみ（時刻0）にする。JST基準の「今日」を作るのに使う。
function jstDateOnly(base: Date): Date {
  const j = new Date(base.getTime() + JST_OFFSET_MS);
  return new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()));
}

// 配達希望日の検証（任意）。指定があれば「確定日+MIN_DAYS 〜 +MAX_MONTHS」の範囲か検証する。
// クライアントの日付操作を信用しないため、範囲はサーバ側(JST)でも必ず確認する。
function validateDeliveryDate(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return ""; // 未指定（おまかせ）。
  const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!mm) throw new ReceiveError(400, "invalid_delivery_date");
  const [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  const picked = new Date(Date.UTC(y, m - 1, d));
  // 存在しない日付（例: 2-31）はロールオーバーで不一致になるので弾く。
  if (picked.getUTCFullYear() !== y || picked.getUTCMonth() !== m - 1 || picked.getUTCDate() !== d) {
    throw new ReceiveError(400, "invalid_delivery_date");
  }
  const today = jstDateOnly(new Date());
  const min = new Date(today); min.setUTCDate(min.getUTCDate() + DELIVERY.MIN_DAYS);
  const max = new Date(today); max.setUTCMonth(max.getUTCMonth() + DELIVERY.MAX_MONTHS);
  if (picked < min || picked > max) throw new ReceiveError(400, "invalid_delivery_date");
  return s;
}

// 配達希望時間帯の検証（任意）。指定があれば許可された5区分のいずれかであること。
function validateDeliveryTime(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return ""; // 未指定（おまかせ）。
  if (!(DELIVERY.TIME_SLOTS as readonly string[]).includes(s)) {
    throw new ReceiveError(400, "invalid_delivery_time");
  }
  return s;
}

/**
 * GET /api/receiveGetCard?token=...
 *   res(200): { ok:true, status:"unused", cardType:{id,name,price}, products:[{id,name,description,imageUrl}] }
 *       あるいは { ok:true, status:"used" }（使用済み＝二重利用防止表示用。商品情報は返さない）
 *   res(404): { ok:false, code:"not_found" }（無効トークン）
 */
export const receiveGetCard = onRequest(HTTP_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const token = tokenOf(req.query.token);
  if (!token) { res.status(400).json({ ok: false, code: "invalid_argument" }); return; }

  try {
    const cardSnap = await giftCardsRef.where("token", "==", token).limit(1).get();
    if (cardSnap.empty) { res.status(404).json({ ok: false, code: "not_found" }); return; }
    const card = cardSnap.docs[0].data();

    // 使用済みなら商品情報は返さず状態のみ（二重利用防止表示）。
    if (card.status === CARD_STATUS.USED) {
      res.status(200).json({ ok: true, status: CARD_STATUS.USED });
      return;
    }

    // 種別＋その種別に紐づく有効な商品ラインナップを返す。
    const [typeSnap, prodSnap] = await Promise.all([
      giftCardTypesRef.doc(card.cardTypeId).get(),
      selectableProductsRef.where("cardTypeId", "==", card.cardTypeId).where("active", "==", true).get(),
    ]);
    const type = typeSnap.data();
    const products = prodSnap.docs.map((d) => {
      const p = d.data();
      return { id: d.id, name: p.name, description: p.description, imageUrl: p.imageUrl };
    });

    res.status(200).json({
      ok: true,
      status: CARD_STATUS.UNUSED,
      cardType: type ? { id: typeSnap.id, name: type.name, price: type.price } : null,
      products,
    });
  } catch (err) {
    logger.error("receiveGetCard failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
  }
});

/**
 * POST /api/receiveConfirm
 *   body: {
 *     token, selectedProductId,
 *     shippingAddress:{name,nameKana,postalCode,prefecture,address,building?,phone},
 *     email, emailConfirm, deliveryDate?, deliveryTime?
 *   }
 *   res(200): { ok:true }
 *   res(400): invalid_argument / invalid_address / invalid_email /
 *             invalid_delivery_date / invalid_delivery_time / invalid_product
 *   res(404): not_found（無効トークン）
 *   res(409): already_used（同時確定・再確定＝二重利用防止）
 *
 * 二重確定防止: トランザクション内で「status が unused であること」を検証してから used に更新する。
 */
export const receiveConfirm = onRequest(HTTP_OPTIONS, async (req, res) => {
  applyCors(req.headers, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, code: "method_not_allowed" }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = tokenOf(body.token);
  const selectedProductId = typeof body.selectedProductId === "string" ? body.selectedProductId.trim() : "";
  if (!token || !selectedProductId) { res.status(400).json({ ok: false, code: "invalid_argument" }); return; }

  let shippingAddress: ShippingAddress;
  let recipientEmail: string;
  let deliveryDate: string;
  let deliveryTime: string;
  try {
    shippingAddress = validateAddress(body.shippingAddress);
    recipientEmail = validateEmail(body.email, body.emailConfirm);
    deliveryDate = validateDeliveryDate(body.deliveryDate);
    deliveryTime = validateDeliveryTime(body.deliveryTime);
  } catch (e) {
    if (e instanceof ReceiveError) { res.status(e.httpStatus).json({ ok: false, code: e.code }); return; }
    throw e;
  }

  try {
    await db.runTransaction(async (tx) => {
      // --- 読み取りはすべて書き込みより前に行う（Firestoreトランザクション制約）---
      const cardSnap = await tx.get(giftCardsRef.where("token", "==", token).limit(1));
      if (cardSnap.empty) throw new ReceiveError(404, "not_found");
      const cardDoc = cardSnap.docs[0];
      const card = cardDoc.data();

      // 二重確定防止の要: この瞬間に unused であることを検証する。
      if (card.status !== CARD_STATUS.UNUSED) throw new ReceiveError(409, "already_used");

      // 選択商品の妥当性: 実在し、同じ種別に属し、有効であること（1カード1商品 / design.md 3.3）。
      const prodDoc = await tx.get(selectableProductsRef.doc(selectedProductId));
      if (!prodDoc.exists) throw new ReceiveError(400, "invalid_product");
      const prod = prodDoc.data()!;
      if (prod.cardTypeId !== card.cardTypeId || prod.active === false) {
        throw new ReceiveError(400, "invalid_product");
      }

      // --- 書き込み: 使用済み化＋確定内容の記録。NE投入は第6でのため neStatus は pending（未投入）---
      // 任意項目（配達希望）は指定があるときだけ書く（undefined を Firestore に書けないため）。
      const update: Record<string, unknown> = {
        status: CARD_STATUS.USED,
        selectedProductId,
        shippingAddress,
        recipientEmail,
        usedAt: FieldValue.serverTimestamp(),
        neStatus: NE_STATUS.PENDING,
      };
      if (deliveryDate) update.deliveryDate = deliveryDate;
      if (deliveryTime) update.deliveryTime = deliveryTime;
      tx.update(cardDoc.ref, update);
    });
  } catch (err) {
    if (err instanceof ReceiveError) {
      // 業務エラーは想定内。409/404/400 をそのまま返す（ログは軽く）。
      if (err.httpStatus >= 500) logger.error("receiveConfirm error", { code: err.code });
      res.status(err.httpStatus).json({ ok: false, code: err.code });
      return;
    }
    logger.error("receiveConfirm failed", { message: err instanceof Error ? err.message : "unknown" });
    res.status(500).json({ ok: false, code: "internal" });
    return;
  }

  res.status(200).json({ ok: true });
});

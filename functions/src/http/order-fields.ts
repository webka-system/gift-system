/*
 * 受注入力フィールドの検証（受け取り者確定・管理者編集で共通）
 *
 * receiveConfirm（受け取り者）と adminUpdateGiftCard（管理者編集）で **同一のルール**を適用するため、
 * 住所・カナ・メール・配達希望日/時間帯の検証をここに集約する。クライアントの入力・日付操作を信用せず、
 * サーバ側（JST基準）で必ず確認する。
 */

import { DELIVERY } from "../config/constants";
import { ShippingAddress } from "../models";

/** 業務エラー（HTTPステータス＋コードへマップする）。 */
export class OrderError extends Error {
  constructor(public httpStatus: number, public code: string) {
    super(code);
  }
}

// 全角カナ（カタカナブロック U+30A0–30FF ＋全角スペース U+3000 ＋半角空白）。氏名カナの形式チェック用。
const KANA_RE = /^[゠-ヿ\u3000\s]+$/;
// 簡易メール形式（前後空白なし・@・ドメインにドット）。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// クライアントの日付操作を信用しないためのサーバ側 JST 基準。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 配送先住所の検証。必須文字列が揃っているかを確認し、正規化して返す。 */
export function validateAddress(raw: unknown): ShippingAddress {
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
    throw new OrderError(400, "invalid_address");
  }
  // 氏名カナは全角カナ形式（NEの受注名カナ／発送先カナに必要）。
  if (!KANA_RE.test(addr.nameKana)) {
    throw new OrderError(400, "invalid_address");
  }
  return addr;
}

/** メールアドレスの検証（必須＋形式）。NEの受注メールアドレス（通知宛先）になる。 */
export function validateEmail(rawEmail: unknown): string {
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  if (!EMAIL_RE.test(email)) {
    throw new OrderError(400, "invalid_email");
  }
  return email;
}

// 指定日を UTC の日付のみ（時刻0）にする。JST基準の「今日」を作るのに使う。
function jstDateOnly(base: Date): Date {
  const j = new Date(base.getTime() + JST_OFFSET_MS);
  return new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()));
}

/**
 * 配達希望日の検証（任意）。指定があれば「当日+MIN_DAYS 〜 +MAX_MONTHS」の範囲か検証する。
 * 受け取り者確定・管理者編集のどちらも、その操作日を基準に同じ範囲で判定する。
 */
export function validateDeliveryDate(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return ""; // 未指定（おまかせ）。
  const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!mm) throw new OrderError(400, "invalid_delivery_date");
  const [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  const picked = new Date(Date.UTC(y, m - 1, d));
  // 存在しない日付（例: 2-31）はロールオーバーで不一致になるので弾く。
  if (picked.getUTCFullYear() !== y || picked.getUTCMonth() !== m - 1 || picked.getUTCDate() !== d) {
    throw new OrderError(400, "invalid_delivery_date");
  }
  const today = jstDateOnly(new Date());
  const min = new Date(today); min.setUTCDate(min.getUTCDate() + DELIVERY.MIN_DAYS);
  const max = new Date(today); max.setUTCMonth(max.getUTCMonth() + DELIVERY.MAX_MONTHS);
  if (picked < min || picked > max) throw new OrderError(400, "invalid_delivery_date");
  return s;
}

/** 配達希望時間帯の検証（任意）。指定があれば許可された5区分のいずれかであること。 */
export function validateDeliveryTime(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return ""; // 未指定（おまかせ）。
  if (!(DELIVERY.TIME_SLOTS as readonly string[]).includes(s)) {
    throw new OrderError(400, "invalid_delivery_time");
  }
  return s;
}

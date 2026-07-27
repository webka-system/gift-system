/**
 * MakeShop クーポン発行（createCoupon）
 *
 * ★スキーマは introspection を省略し「実際に1件発行してエラーを見ながら直す」方針（NEのCSV取込と同じ実証アプローチ）。
 *   下記 FIELD 定数・ENUM 定数・MUTATION は **推定を含む**。MakeShop が
 *   「そのフィールドは無い / enum値が違う / 引数名が違う」等を errors[] で返したら、ここを実スキーマに合わせて直す。
 *   → createCouponRaw は成功/失敗のいずれでも **生レスポンス(raw)** を返すので、呼び出し側（管理テスト）で
 *     errorMessage をそのまま確認できる。
 *
 * 渡す内容（確定仕様）:
 *   - code: gift-system 側でランダム生成（半角小文字英数字・大小区別なし前提の32字種16桁 / shared COUPON.CODE）
 *   - name: 種別名
 *   - 割引: 定額 fixedAmount(円) または 定率 fixedRate(%)（種別 couponConfig より）
 *   - isForOnlyMember: true（会員限定）
 *   - useCountType: "UENUCT4"（お一人様1回）
 *   - minimumPrice: 任意（最低購入額）
 *   - endedAt: couponExpiryAt（絶対日付・ロット単位）
 *   - 対象商品: 全商品（対象限定フィールドは送らない）
 */

import { randomInt } from "node:crypto";
import { COUPON } from "../config/constants";
import { makeshopGraphql, MakeshopCallDeps } from "./client";

// ===== 推定フィールド名（エラーが出たら実スキーマに合わせて差し替える箇所を1か所に集約）=====
// createCoupon の引数名と入力型（推定）。
// ★レスポンス: code/name/status/errorMessage は CreateCouponResponse 直下ではなく **results（配列）の中**にある
//   （実接続の 422 エラー「Cannot query field "status" ... on type "CreateCouponResponse"」で確定）。
//   1件発行なので results[0] から成否・コードを取り出す（extractResult が results[0] を見る）。
const MUTATION = `
mutation CreateCoupon($input: CreateCouponRequest!) {
  createCoupon(input: $input) {
    results {
      code
      name
      status
      errorMessage
    }
  }
}`;

// MakeShop DiscountType enum（実スキーマ確認済み）。gift-system 内部の "amount"/"rate" から変換する。
const DISCOUNT_TYPE_ENUM: Record<string, string> = {
  [COUPON.DISCOUNT_TYPE.AMOUNT]: "FIXED_AMOUNT",
  [COUPON.DISCOUNT_TYPE.RATE]: "FIXED_RATE",
};

/** クーポン割引の指定（種別 couponConfig 由来）。 */
export interface CouponDiscount {
  /** "amount"=定額(円) / "rate"=定率(%)。 */
  discountType: string;
  /** 割引額（amount:円 / rate:%）。 */
  discountValue: number;
}

/** createCoupon に渡すパラメータ（gift-system 側の意味で表現。GraphQL入力への変換は下で行う）。 */
export interface CreateCouponParams {
  code: string;
  name: string;
  discount: CouponDiscount;
  /** 最低購入額（任意）。 */
  minimumPrice?: number;
  /** 利用開始日時（"YYYY-MM-DD HH:mm:ss"）。hasPeriod=true のとき必須。 */
  startedAt: string;
  /** 利用終了日時（"YYYY-MM-DD HH:mm:ss"）＝クーポン有効期限。hasPeriod=true のとき必須。 */
  endedAt: string;
}

/** createCoupon の結果（成否＋MakeShopが返した情報＋生レスポンス）。 */
export interface CreateCouponResult {
  ok: boolean;
  /** MakeShop が確定したクーポンコード（基本は送った code と同じ想定）。 */
  code?: string;
  /** MakeShop のステータス文字列（"OK"/"NG" 等・推定）。 */
  status?: string;
  /** 失敗理由（GraphQL errors か レスポンスの errorMessage）。 */
  errorMessage?: string;
  /** 生レスポンス（デバッグ・スキーマ調整用。必ず入れる）。 */
  raw: unknown;
}

/**
 * ランダムなクーポンコードを生成する。
 * MakeShop 制約: 半角英数字20文字以内・大小区別なし → 実効32字種（COUPON.CODE.ALPHABET）で LENGTH 桁。
 * 推測困難性のため crypto の乱数を使う（Math.random は使わない）。
 */
export function generateCouponCode(): string {
  const { ALPHABET, LENGTH } = COUPON.CODE;
  let out = "";
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(0, ALPHABET.length)];
  return out;
}

/**
 * GraphQL 入力（CreateCouponRequest）を組み立てる。実スキーマ確認済み:
 *   入力は { coupons: [CreateCoupon] } の**リスト**（今回は1件）。CreateCoupon の各フィールドは下記。
 *   利用回数は useCountType ではなく boolean ゲート＋数値で表す。日付は "YYYY-MM-DD HH:mm:ss"。
 */
function buildInput(params: CreateCouponParams): Record<string, unknown> {
  const coupon: Record<string, unknown> = {
    code: params.code,           // 自前生成コード（codeAutoCreate は使わない）。
    name: params.name,           // String!（必須）。
    isEnabled: true,             // 発行後すぐ使える状態に。
    isForOnlyMember: COUPON.IS_FOR_ONLY_MEMBER,   // 会員限定（確定仕様）。
    // お一人様1回（会員限定が前提）。
    hasMaximumMemberUsableCount: true,
    maximumMemberUsableCount: COUPON.MEMBER_USABLE_COUNT, // 1
    // 全体でも1回（コードは株主1名専用。転送されても使い回せない）。
    hasTotalUseCount: true,
    totalUseCount: COUPON.TOTAL_USE_COUNT,               // 1
    // 対象商品=全商品（isTargetProduct=false）。
    isTargetProduct: false,
    // 割引方式（DiscountType enum）＋金額/率。
    discountType: DISCOUNT_TYPE_ENUM[params.discount.discountType] ?? "FIXED_RATE",
    // 有効期間（絶対日時）。開始・終了とも必須。
    hasPeriod: true,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
  };
  // 割引: 定率なら fixedRate(%)、定額なら fixedAmount(円)。
  if (params.discount.discountType === COUPON.DISCOUNT_TYPE.RATE) {
    coupon.fixedRate = params.discount.discountValue;
  } else {
    coupon.fixedAmount = params.discount.discountValue;
  }
  // 最低購入額（任意）。
  if (typeof params.minimumPrice === "number" && params.minimumPrice > 0) {
    coupon.hasMinimumPrice = true;
    coupon.minimumPrice = params.minimumPrice;
  }
  // CreateCouponRequest は coupons（配列）を1フィールドだけ持つ。1件発行なので要素1。
  return { coupons: [coupon] };
}

/**
 * レスポンスから status / code / errorMessage を寛容に取り出す（実際の入れ子が不明なため）。
 * data.createCoupon 直下、または results/result 配下などをたどる。
 */
function extractResult(data: unknown): { status?: string; code?: string; errorMessage?: string } {
  const cc = (data as { createCoupon?: unknown } | undefined)?.createCoupon;
  // 候補ノード（直下 / results[0] / result）を順に見る。
  const candidates: unknown[] = [];
  if (cc && typeof cc === "object") {
    candidates.push(cc);
    const anyCc = cc as Record<string, unknown>;
    if (Array.isArray(anyCc.results)) candidates.push(anyCc.results[0]);
    if (anyCc.result) candidates.push(anyCc.result);
  }
  for (const node of candidates) {
    if (node && typeof node === "object") {
      const n = node as Record<string, unknown>;
      const status = typeof n.status === "string" ? n.status : undefined;
      const code = typeof n.code === "string" ? n.code : undefined;
      const errorMessage = typeof n.errorMessage === "string" ? n.errorMessage : undefined;
      if (status !== undefined || code !== undefined || errorMessage !== undefined) {
        return { status, code, errorMessage };
      }
    }
  }
  return {};
}

/** 成功ステータスかどうか。CreateCouponResultStatus enum は SUCCESS / FAIL（実スキーマ確認済み）。 */
function isOkStatus(status: string | undefined): boolean {
  if (!status) return false;
  return /^success$/i.test(status);
}

/**
 * createCoupon を1回だけ呼ぶ（リトライなし）。成否と生レスポンスを返す（例外は投げない、通信断を除く）。
 */
export async function createCouponRaw(
  params: CreateCouponParams,
  deps: MakeshopCallDeps = {},
): Promise<CreateCouponResult> {
  const resp = await makeshopGraphql(MUTATION, { input: buildInput(params) }, deps);
  const d = resp.diagnostics;

  // 通信レベルの失敗（HTTP 404・非JSON・env未反映・secret未注入・fetch例外）。
  // → 「どこへ何を送って何が返ったか」を errorMessage と raw にそのまま出す（404 の切り分け用）。
  if (!resp.ok && !resp.errors) {
    return {
      ok: false,
      errorMessage: `HTTP ${d.httpStatus} ${d.method} ${d.url} :: ${d.bodyText}`.slice(0, 800),
      raw: { diagnostics: d },
    };
  }

  // GraphQL レベルのエラー（不明フィールド・enum不一致・認証等）はここで拾って errorMessage に。
  if (resp.errors && resp.errors.length > 0) {
    return {
      ok: false,
      errorMessage: resp.errors.map((e) => e.message).join(" | "),
      raw: { errors: resp.errors, diagnostics: d },
    };
  }

  const { status, code, errorMessage } = extractResult(resp.data);
  const ok = isOkStatus(status);
  return {
    ok,
    status,
    code: code || (ok ? params.code : undefined),
    errorMessage: ok ? undefined : (errorMessage || `unexpected response status: ${status ?? "(none)"}`),
    raw: { data: resp.data, diagnostics: d },
  };
}

/** errorMessage がコード重複っぽいか（重複時だけコード再生成でリトライする）。 */
function looksLikeDuplicate(msg: string | undefined): boolean {
  if (!msg) return false;
  return /重複|既に|存在|duplicat|already|exист|exist/i.test(msg);
}

/**
 * createCoupon を、コード重複(status:NG)のときだけコードを再生成してリトライしながら呼ぶ。
 *   - 重複以外の失敗（不明フィールド・enum不一致等）は**即座に返す**（リトライで直らないため。エラーを早く見る）。
 *   - 呼び出し側で code を都度渡す必要はない：ここで generateCouponCode して差し替える。
 * 返り値の code は「実際に発行に使った（成功した）コード」。
 */
export async function createCouponWithRetry(
  base: Omit<CreateCouponParams, "code">,
  deps: MakeshopCallDeps = {},
): Promise<CreateCouponResult> {
  let last: CreateCouponResult | null = null;
  for (let attempt = 0; attempt < COUPON.CODE.MAX_RETRY; attempt++) {
    const code = generateCouponCode();
    const result = await createCouponRaw({ ...base, code }, deps);
    if (result.ok) return result;
    last = result;
    // 重複でなければリトライしても同じエラー。即返す。
    if (!looksLikeDuplicate(result.errorMessage)) return result;
  }
  // 重複でリトライ上限に達した。
  return last ?? { ok: false, errorMessage: "createCoupon failed without response", raw: null };
}

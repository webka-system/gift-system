/*
 * 受注ステータス表示ロジック（グループB / 受注確認ビュー）
 *
 * QR一覧・受注詳細で使う「状態バッジ」の組み立てをここに集約する。
 * DOM や Firebase に依存しない純粋関数なので、SSOT 定数（/shared/constants.js）に対して
 * 単体で検証できる。バッジの CSS クラスは admin.css の .badge-* と対応する。
 */

import { CARD_STATUS, NE_STATUS } from "/shared/constants.js";

/**
 * NE 投入状態（neStatus）を、日本語ラベルとバッジ種別（CSSクラス接尾辞 .badge-<kind>）に変換する。
 * 使用済みカードの neStatus をもとに、発送漏れにつながる「失敗」を目立たせるのが狙い。
 * 未知値・未設定は「NE未投入」に倒す（拾い漏れを防ぐ安全側）。
 */
export function neStatusInfo(neStatus) {
  switch (neStatus) {
    case NE_STATUS.SUBMITTED:    return { label: "NE投入済", kind: "ne-ok" };
    case NE_STATUS.CSV_EXPORTED: return { label: "CSV出力済", kind: "ne-ok" };
    case NE_STATUS.SUBMITTING:   return { label: "NE投入中", kind: "ne-progress" };
    case NE_STATUS.QUEUED:       return { label: "NE受付済(確認待ち)", kind: "ne-progress" };
    case NE_STATUS.ERROR:        return { label: "NE投入失敗", kind: "ne-error" };
    case NE_STATUS.PENDING:      return { label: "NE未投入", kind: "ne-pending" };
    default:                     return { label: "NE未投入", kind: "ne-pending" };
  }
}

/**
 * 一覧・詳細で使う「状態」バッジ HTML を返す。
 * 未使用は「未使用」。期限切れ（未使用のまま期限超過）は「期限切れ」を赤で強調（発送されず終わるカードなので
 * 失敗系と同様に気づけるように）。残り日数が近い未使用は「期限間近」を付す。使用済みは「使用済」＋NE投入状態。
 * expiry: { expired?:boolean, near?:boolean }（省略時は期限判定なし＝従来どおり）。
 * ラベルはいずれも固定の安全な文字列なのでエスケープ不要。
 */
export function statusBadgeHtml(card, expiry = {}) {
  if (card.status !== CARD_STATUS.USED) {
    if (expiry.expired) return `<span class="badge badge-expired">期限切れ</span>`;
    return `<span class="badge badge-unused">未使用</span>` +
      (expiry.near ? ` <span class="badge badge-near">期限間近</span>` : "");
  }
  const ne = neStatusInfo(card.neStatus);
  return `<span class="badge badge-used">使用済</span>` +
    ` <span class="badge badge-${ne.kind}">${ne.label}</span>`;
}

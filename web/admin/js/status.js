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
    case NE_STATUS.ERROR:        return { label: "NE投入失敗", kind: "ne-error" };
    case NE_STATUS.PENDING:      return { label: "NE未投入", kind: "ne-pending" };
    default:                     return { label: "NE未投入", kind: "ne-pending" };
  }
}

/**
 * 一覧・詳細で使う「状態」バッジ HTML を返す。
 * 未使用は1つのバッジ。使用済みは「使用済」＋ NE 投入状態の2バッジで、
 * 発送漏れの元になる「NE投入失敗」がパッと目に入るようにする（赤で強調）。
 * ラベルはいずれも固定の安全な文字列なのでエスケープ不要。
 */
export function statusBadgeHtml(card) {
  if (card.status !== CARD_STATUS.USED) {
    return `<span class="badge badge-unused">未使用</span>`;
  }
  const ne = neStatusInfo(card.neStatus);
  return `<span class="badge badge-used">使用済</span>` +
    ` <span class="badge badge-${ne.kind}">${ne.label}</span>`;
}

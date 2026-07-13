/**
 * アップロードキューの取込結果確認（/api_v1_system_que/search）
 *
 * 受注伝票アップロードは非同期キュー方式なので、アップロードで得た que_id を照会して**実際の取り込み結果**を確認する。
 *
 * ★NEの仕様（公式リファレンス）:
 *   - POST パラメータ: access_token(必須) / refresh_token / fields(必須・カンマ区切り) / offset / limit / wait_flag。
 *     絞り込みは `<フィールド名>-<比較演算子>`（例: que_id-eq=45）。
 *   - que_status_id: **2=全処理成功 / 1=処理中 / 0=処理待ち / -1=処理失敗**。詳細は que_message。
 */

import { NeCallDeps, neApiCall } from "./client";
import { neConfig } from "../config/env";

/** キュー検索のフィールド名。 */
export const NE_QUE_FIELDS = {
  id: "que_id",
  statusId: "que_status_id",
  message: "que_message",
  methodName: "que_method_name",
} as const;

/** que_status_id の意味（NE公式）。 */
export type NeQueStatus = "success" | "processing" | "waiting" | "failed" | "unknown";

export interface NeQueResult {
  /** 判定した状態。 */
  status: NeQueStatus;
  /** 生の que_status_id（"2"/"1"/"0"/"-1"/その他）。 */
  statusId: string;
  /** que_message（失敗理由・警告等。運用調査用）。 */
  message: string;
  /** 該当キューが見つかったか。 */
  found: boolean;
}

interface QueRow {
  [k: string]: unknown;
}

/** que_status_id を状態種別へ写像する。 */
export function mapQueStatusId(statusId: string): NeQueStatus {
  switch (statusId) {
    case "2": return "success";
    case "1": return "processing";
    case "0": return "waiting";
    case "-1": return "failed";
    default: return "unknown";
  }
}

/**
 * que_id でキューを検索し、取り込み結果を返す。
 *   - success（==2）: 取り込み完了。呼び出し側で submitted に確定してよい。
 *   - failed（==-1）: 取り込み失敗。message を neLastError に記録して pending に戻す（リトライ）。
 *   - processing/waiting: まだ処理中。queued のまま次回再確認。
 *   - not found（found=false）: 反映遅延の可能性。processing 扱い（queued 維持）にするのが安全。
 */
export async function checkQueStatus(queId: string, deps: NeCallDeps = {}): Promise<NeQueResult> {
  const cfg = neConfig();
  const F = NE_QUE_FIELDS;
  const res = await neApiCall(
    cfg.queEndpoint,
    {
      fields: [F.id, F.statusId, F.message, F.methodName].join(","),
      [`${F.id}-eq`]: queId,
      limit: 1,
    },
    deps,
  );
  const rows: QueRow[] = Array.isArray((res as { data?: unknown }).data)
    ? ((res as { data: QueRow[] }).data)
    : [];
  const row = rows.find((r) => String(r[F.id] ?? "") === String(queId)) ?? rows[0];
  if (!row) {
    return { status: "unknown", statusId: "", message: "", found: false };
  }
  const statusId = String(row[F.statusId] ?? "");
  return {
    status: mapQueStatusId(statusId),
    statusId,
    message: String(row[F.message] ?? ""),
    found: true,
  };
}

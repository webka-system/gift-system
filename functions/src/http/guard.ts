/**
 * HTTP関数の共通ガード（管理API用 / gift-system 版）
 *
 * 方針（ハイブリッド構成）:
 *   - 管理画面（web/admin）は Firebase Auth（メール/パスワード）でログイン必須。
 *   - gift-system は「ログイン済み＝管理者」とみなす簡易モデル（アカウントは管理者がコンソール等で発行し、
 *     一般公開のサインアップは行わない前提）。将来 admins コレクション照合を足す場合は
 *     requireAuth を差し替える（label-system の requireOperatorAuth 相当）。
 *   - 失敗・例外・設定不備はすべて拒否（fail-closed）。
 *
 * ※ 受け取り者フロー（giftCards の使用）は別ガード（トークン照合）で扱う。ここは管理API専用。
 */

import { logger } from "firebase-functions/v2";
import { getAuth } from "firebase-admin/auth";

interface StatusJsonResponse {
  status(n: number): { json(b: unknown): unknown };
}
interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** 認証を通ったユーザーの素性。 */
export interface AdminIdentity {
  uid: string;
  email: string | null;
}

/** テスト時に差し替え可能にするための注入点。 */
export interface AuthDeps {
  verifyToken(token: string): Promise<{ uid: string; email?: string | null }>;
}

const defaultDeps: AuthDeps = {
  async verifyToken(token: string) {
    const decoded = await getAuth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email ?? null };
  },
};

// Authorization: Bearer <idToken> から token を取り出す。無ければ null。
function bearerTokenOf(req: AuthRequest): string | null {
  const h = req.headers["authorization"] ?? req.headers["Authorization"];
  const raw = Array.isArray(h) ? h[0] : h;
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m && m[1] ? m[1].trim() : null;
}

/**
 * 管理API（admin*）のガード。Firebase Auth のIDトークンを検証する。
 *   - 成功：AdminIdentity を返す（res には何も書かない）。
 *   - 失敗：res に 401 を書き込み null を返す（呼び出し側は return で中断する）。
 *
 * 使い方（各ハンドラ先頭で）:
 *   const admin = await requireAuth(req, res); if (!admin) return;
 */
export async function requireAuth(
  req: AuthRequest,
  res: StatusJsonResponse,
  deps: AuthDeps = defaultDeps,
): Promise<AdminIdentity | null> {
  const token = bearerTokenOf(req);
  if (!token) {
    res.status(401).json({ ok: false, code: "unauthenticated" });
    return null;
  }
  try {
    const decoded = await deps.verifyToken(token);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch (err) {
    // トークン本体・顧客情報は出さない。原因切り分け用に code のみ。
    const e = err as { code?: unknown };
    logger.warn("requireAuth: token verify failed", {
      code: typeof e?.code === "string" ? e.code : null,
      message: err instanceof Error ? err.message : "unknown",
    });
    res.status(401).json({ ok: false, code: "unauthenticated" });
    return null;
  }
}

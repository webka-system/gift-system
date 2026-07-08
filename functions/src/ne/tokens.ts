/**
 * NE アクセストークン/リフレッシュトークンの保管（Firestore 専用ドキュメント）
 *
 * NE API はレスポンスに更新後の access_token / refresh_token を返すことがあり、返ってきたら
 * 保存して次回はそれを使う（自前で有効期限を追うより、返却トークンを毎回書き戻すのが NE 流）。
 * → 頻繁に書き換わるため .env ではなく Firestore に置く（neAuth/tokens の単一ドキュメント）。
 *
 * セキュリティ:
 *   - firestore.rules は neAuth を明示許可していない＝クライアント全拒否（catch-all deny）。
 *     読み書きは Functions（admin SDK）経由のみ。
 *   - client_id / client_secret は静的な秘匿値として .env（config/env.ts）に置く（ここには保存しない）。
 */

import { db } from "../lib/firestore";

export interface NeTokens {
  accessToken: string;
  refreshToken: string;
}

/** テスト時に差し替え可能なトークンストアの契約。 */
export interface NeTokenStore {
  load(): Promise<NeTokens>;
  save(tokens: NeTokens): Promise<void>;
}

const TOKENS_DOC = () => db.collection("neAuth").doc("tokens");

/** 既定（本番）の Firestore トークンストア。 */
export const firestoreTokenStore: NeTokenStore = {
  async load() {
    const snap = await TOKENS_DOC().get();
    const d = snap.exists ? snap.data() : undefined;
    return {
      accessToken: typeof d?.accessToken === "string" ? d.accessToken : "",
      refreshToken: typeof d?.refreshToken === "string" ? d.refreshToken : "",
    };
  },
  async save(tokens: NeTokens) {
    await TOKENS_DOC().set(
      { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, updatedAt: new Date() },
      { merge: true },
    );
  },
};

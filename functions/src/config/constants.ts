/**
 * 共通定数（SSOT = Single Source of Truth）への単一の参照点。
 *
 * コレクション名・ステータス列挙・トークン仕様・リージョン等は shared/constants.js に集約されている。
 * バックエンドのコードは文字列をベタ書きせず、必ずこのモジュール経由で参照すること。
 *   例: import { COLLECTIONS, CARD_STATUS, TOKEN, REGION } from "../config/constants";
 *
 * ビルドメモ（label-system に準拠）:
 *   tsconfig の rootDir=".." と include: ../shared/constants.js により、
 *   shared/constants.js は lib/shared/constants.js としてコンパイル・デプロイされる。
 *   型は TypeScript の JS 型推論で付与される（定数の複製を避けるため別 .d.ts は置かない）。
 */

// 単一情報源をそのまま再公開する（複製しない）。
export * from "../../../shared/constants.js";

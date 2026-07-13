/**
 * 配達希望日の範囲判定（shared/delivery.js）への単一の参照点。
 *
 * 受け取り者(client)と単体テストが同一ロジックを使うための SSOT。
 * ビルド構成は config/expiry.ts と同様（tsconfig include ＋ rootDir=".."）。
 */

export * from "../../../shared/delivery.js";

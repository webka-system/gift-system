/**
 * 有効期限判定（shared/expiry.js）への単一の参照点。
 *
 * 受け取り者確定（receive.ts）と管理画面が同一ロジックを使うための SSOT。
 * バックエンドはここ経由で参照する（値・ロジックを複製しない）。
 * ビルド構成は config/constants.ts と同様（tsconfig include ＋ rootDir=".."）。
 */

export * from "../../../shared/expiry.js";

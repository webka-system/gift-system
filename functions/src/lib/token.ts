/**
 * トークン生成（受け取り者アクセス用 URL トークン）
 *
 * 役割:
 *   発行する QR カードごとに「推測不可能なトークン」を発行する。これが外部アクセス制御の要
 *   （design.md 第8章 / firestore.rules は受け取り者向けの口を開けず、トークン照合はサーバ側で行う）。
 *
 * セキュリティ要件（必守）:
 *   - 暗号学的に安全な乱数を使う。Math.random() は不可。Node 標準の crypto を使う。
 *   - バイト数は shared/constants.js の TOKEN.BYTES を使い、ベタ書きしない。
 *   - URL に載るため URL-safe な文字集合（base64url）にする。
 *   - 連番・短い値は禁止（総当りで他カードに当たらない長さを担保）。
 */

import { randomBytes } from "node:crypto";
import { TOKEN } from "../config/constants";

/**
 * 推測不可能な URL-safe トークンを生成する。
 * - crypto.randomBytes（暗号学的に安全）を使用。Math.random() は使わない。
 * - バイト数は shared/constants.js の TOKEN.BYTES を既定とする（base64url でおよそ 1.33 倍の文字数）。
 * - base64url（A-Z a-z 0-9 - _）で URL に安全に載る文字集合のみ。
 */
export function generateCardToken(bytes: number = TOKEN.BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * 印刷工場入稿用の URL 一覧 Excel(xlsx) 生成（design.md 4.1「印刷用出力」）
 *
 * 受け取り者URL（/g/<token>）を1行ずつ並べた xlsx を作る。工場は A列（URL）だけを参照する想定。
 * 管理側の突合用に B列=token / C列=種別名 を付ける。URL_ONLY / INCLUDE_HEADER で構成を切り替え可能。
 *
 * xlsx 生成は exceljs（Nodeの定番）を使用。純粋関数（Firestore/HTTP非依存）でテストしやすくしてある。
 */

import ExcelJS from "exceljs";
import { URL_EXPORT } from "../config/constants";

/** 1行分のデータ。 */
export interface UrlRow {
  url: string;
  token: string;
  cardTypeName: string;
}

export interface UrlXlsxOptions {
  urlOnly?: boolean;
  includeHeader?: boolean;
}

/**
 * URL一覧の xlsx バッファを生成する。
 *   - urlOnly=true: A列(URL)のみ。false: A=URL / B=token / C=種別名。
 *   - includeHeader: 先頭にヘッダ行を付けるか。
 * 既定は shared/constants.js の URL_EXPORT に従う。
 */
export async function buildUrlListXlsx(rows: UrlRow[], opts: UrlXlsxOptions = {}): Promise<Buffer> {
  const urlOnly = opts.urlOnly ?? URL_EXPORT.URL_ONLY;
  const includeHeader = opts.includeHeader ?? URL_EXPORT.INCLUDE_HEADER;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(URL_EXPORT.SHEET_NAME);

  const columns = urlOnly
    ? [{ header: URL_EXPORT.HEADERS.url, key: "url", width: 60 }]
    : [
        { header: URL_EXPORT.HEADERS.url, key: "url", width: 60 },
        { header: URL_EXPORT.HEADERS.token, key: "token", width: 36 },
        { header: URL_EXPORT.HEADERS.cardTypeName, key: "cardTypeName", width: 20 },
      ];

  // exceljs は columns 設定時に自動でヘッダ行を作る。ヘッダ不要なら key だけ使って手動で行を積む。
  if (includeHeader) {
    ws.columns = columns;
    for (const r of rows) {
      ws.addRow(urlOnly ? { url: r.url } : { url: r.url, token: r.token, cardTypeName: r.cardTypeName });
    }
  } else {
    // ヘッダ行なし：A1 からデータを開始（各 A セルが純粋なURLになる）。
    ws.columns = columns.map((c) => ({ key: c.key, width: c.width }));
    for (const r of rows) {
      ws.addRow(urlOnly ? [r.url] : [r.url, r.token, r.cardTypeName]);
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/*
 * shared/*.js → web/shared/ へのコピー（ブラウザ配信用アセットの生成）
 *
 * 背景（2026-07-13 の障害）:
 *   hosting predeploy のコピーが走らず、新規追加した shared/delivery.js が本番で 404 になり、
 *   それを import している受け取り者ページ(receive.js)がモジュール読込失敗で白画面になった。
 *
 * 対策:
 *   1) shared/ 配下の **すべての .js を自動でコピー**する（コピー対象の列挙漏れという事故クラスを無くす）。
 *   2) web/shared/ は git 管理下に置く（この生成物を commit しておく）。predeploy が走らなくても配信が欠けない安全網。
 *
 * 使い方:
 *   - hosting predeploy から自動実行（firebase.json）。
 *   - shared/ に .js を追加/変更したら、手元で `node scripts/sync-shared.js` を実行して web/shared を再生成し **commit** する。
 */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "shared");
const outDir = path.join(root, "web", "shared");

fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js"));
if (files.length === 0) {
  console.error("[sync-shared] ERROR: shared/ に .js が見つかりません。パスを確認してください。");
  process.exit(1);
}
for (const f of files) {
  fs.copyFileSync(path.join(srcDir, f), path.join(outDir, f));
}
console.log(`[sync-shared] copied ${files.length} file(s) to web/shared: ${files.join(", ")}`);

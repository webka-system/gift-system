/**
 * MakeShop GraphQL スキーマの introspection（クーポン関連の型を実データで確定させる）
 *
 * 推定を排除するため、実エンドポイントに introspection を投げて次を取得する:
 *   - CreateCouponRequest（送る入力型）の inputFields（正確なフィールド名・型・enum型名）
 *   - CreateCouponResponse（返る型）の fields（results 配列とその要素型を辿る）
 *   - 上記から参照される **enum 型の値** と **results 要素のオブジェクト型の fields**（status/code 等）を芋づるで取得
 *
 * 認証は makeshopGraphql（固定トークン）に委譲。管理者が adminTestIssueCoupon の introspect モードで1回叩く。
 */

import { makeshopGraphql, MakeshopCallDeps } from "./client";

// 任意の型名の構造を取る汎用 introspection クエリ。
// inputFields(INPUT_OBJECT用) / fields(OBJECT用) / enumValues(ENUM用) を一括で問い合わせる
// （非該当は null で返るだけなので、どの kind の型でも使い回せる）。ofType は List/NonNull のラッパを4段まで剥がす。
const TYPE_QUERY = `
query IntrospectType($name: String!) {
  __type(name: $name) {
    name
    kind
    inputFields {
      name
      type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
    }
    fields {
      name
      type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
    }
    enumValues { name }
  }
}`;

interface TypeRef { kind?: string; name?: string | null; ofType?: TypeRef | null }
interface FieldRef { name: string; type: TypeRef }
interface TypeInfo {
  name?: string;
  kind?: string;
  inputFields?: FieldRef[] | null;
  fields?: FieldRef[] | null;
  enumValues?: { name: string }[] | null;
}

/** 1つの型名の構造を取得する（診断込み）。 */
async function fetchType(name: string, deps: MakeshopCallDeps): Promise<{ type: TypeInfo | null; error?: unknown }> {
  const resp = await makeshopGraphql<{ __type: TypeInfo | null }>(TYPE_QUERY, { name }, deps);
  if (!resp.ok || resp.errors) {
    return { type: null, error: resp.errors ?? resp.diagnostics };
  }
  return { type: resp.data?.__type ?? null };
}

/** TypeRef の ofType チェーンを辿り、出現する named 型名をすべて集める（List/NonNull を剥がす）。 */
function collectTypeNames(t: TypeRef | undefined | null, into: Set<string>): void {
  let cur: TypeRef | undefined | null = t;
  while (cur) {
    if (cur.name) into.add(cur.name);
    cur = cur.ofType;
  }
}

// これ以上たどっても意味のない組み込みスカラ。
const SCALAR = new Set(["String", "Int", "Boolean", "Float", "ID"]);

/**
 * クーポン関連スキーマを実データで取得する。
 * 返り値はそのまま管理画面へ出して人が読む（フィールド名・enum値・結果型の確定に使う）。
 */
export async function introspectCouponSchema(deps: MakeshopCallDeps = {}): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // 1) 入力型・応答型を取得。
  const req = await fetchType("CreateCouponRequest", deps);
  const resp = await fetchType("CreateCouponResponse", deps);
  out.CreateCouponRequest = req.type ?? { error: req.error };
  out.CreateCouponResponse = resp.type ?? { error: resp.error };

  // 2) 参照される型名（enum・results要素のオブジェクト型など）を芋づるで集める。
  const names = new Set<string>();
  for (const f of req.type?.inputFields ?? []) collectTypeNames(f.type, names);
  for (const f of resp.type?.fields ?? []) collectTypeNames(f.type, names);
  // 既に取得済み・スカラは除外。
  names.delete("CreateCouponRequest");
  names.delete("CreateCouponResponse");

  // 3) 各参照型の中身（enumValues / fields）を取得。enum の値や results 要素型（status/code等）が分かる。
  const types: Record<string, unknown> = {};
  for (const name of names) {
    if (SCALAR.has(name)) continue;
    const r = await fetchType(name, deps);
    types[name] = r.type ?? { error: r.error };
  }
  out.referencedTypes = types;

  return out;
}

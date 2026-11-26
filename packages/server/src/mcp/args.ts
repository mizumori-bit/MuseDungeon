// 引数の名前の断り（S1c §14.4 の 2。§8.9 の 1 を改める）: ツールの定義に無い名前の引数・要る引数が無いときは、MCP の SDK の入力の検査の前に受けて、
// ゲームの断りの形（code・hint に呼び方の例・valid_actions・turn・structuredContent）で返す。ツール一覧の「要る引数」は変えない（SDK の検査はそのまま後ろに残る）。
// 別名は足さない。引数の形が違う（型・値の範囲・選べる値）も、S16d から同じ形で断る（検査そのものは、登録した inputSchema で、SDK と同じに行う）
import type { ZodTypeAny } from 'zod';

/** ツールの引数の形（zod の object の shape）。取れなければ null */
export function argShape(schema: unknown): Record<string, ZodTypeAny> | null {
  const s = schema as { shape?: Record<string, ZodTypeAny>; _def?: { shape?: () => Record<string, ZodTypeAny> } } | undefined;
  if (!s) return null;
  if (s.shape && typeof s.shape === 'object') return s.shape;
  if (typeof s._def?.shape === 'function') return s._def.shape();
  return null;
}

/**
 * 共通の名前（S1d §17.1: どのツールでも受ける）。ツールの定義に無ければ、SDK の検査が黙って捨てる（thought は、記録できるツールでは今までどおり記録する）。
 * AI はどのツールにも thought を付け、ステートレスなクライアントは player_token を付けるので、これを断るとふだんの呼び出しが落ちる
 */
export const COMMON_ARGS: ReadonlySet<string> = new Set(['player_token', 'thought', 'expect_seq', 'map', 'inventory', 'status_line']);

/** 定義の上では任意（z.any など）だが、実際には要る引数（断りの引数の一覧で「要る」に書く。S1d §17.1） */
const REQUIRED_EXTRA: Record<string, string[]> = { throw_item: ['target'] };

/** そのツールの要る引数（定義の要る引数と REQUIRED_EXTRA） */
export function requiredArgs(tool: string, shape: Record<string, ZodTypeAny>): string[] {
  const extra = REQUIRED_EXTRA[tool] ?? [];
  return Object.entries(shape).filter(([k, z]) => !z.isOptional() || extra.includes(k)).map(([k]) => k);
}

/**
 * 渡された引数のうち、定義に無い名前（共通の名前は除く）と、足りない要る引数（定義の上で要るもの）。
 * 断るのは、要る引数が足りないとき（知らない名前もあわせて書く）と、共通でない知らない名前が来たとき（S1d §17.1）
 */
export function argProblems(shape: Record<string, ZodTypeAny>, args: Record<string, unknown> | undefined): { unknown: string[]; missing: string[] } {
  const a = args ?? {};
  const unknown = Object.keys(a).filter((k) => !(k in shape) && !COMMON_ARGS.has(k)).sort();
  const missing = Object.entries(shape).filter(([k, z]) => !z.isOptional() && a[k] === undefined).map(([k]) => k);
  return { unknown, missing };
}

/** 呼び方の例（よく間違えるツールは手で書く。ほかは要る引数から作る） */
const EXAMPLES: Record<string, string> = {
  travel_to: "travel_to { to: 'stairs_down' } / travel_to { to: { x: 3, y: 4 } } / travel_to { to: 'e_xxxxxx' }",
  move: "move { dir: 'n' }",
  fight: "fight { target: 'e_xxxxxx' } / fight { target: 'e_xxxxxx', with: 'javelin' }",
  attack: "attack { target: 'e_xxxxxx' }",
  choose_perk: 'choose_perk { option: 1 }',
  choose_boon: 'choose_boon { option: 1 }',
  use_item: "use_item { slot: 'a' } / use_item { slot: 'c', target_slot: 'b' }（鑑定の巻物）",
  throw_item: "throw_item { slot: 'b', target: 'e_xxxxxx' }",
  equip: "equip { slot: 'b' }",
  unequip: "unequip { slot: 'weapon' }",
  drop: "drop { slot: 'b' }",
  interact: "interact { dir: 'e' }",
  start_expedition: 'start_expedition { offer: 1 }',
  use_ability: "use_ability { ability: 'bash', target: 'e_xxxxxx' }",
  collect: "collect { what: 'items', kinds: ['potion'] }",
  explore: "explore { toward: 'draft', max_steps: 40 }",
};

function placeholder(z: ZodTypeAny): string {
  const def = (z as unknown as { _def?: { typeName?: string; values?: string[]; options?: ZodTypeAny[]; innerType?: ZodTypeAny; schema?: ZodTypeAny } })._def;
  switch (def?.typeName) {
    case 'ZodEnum': return `'${def.values?.[0] ?? '…'}'`;
    case 'ZodNumber': return '1';
    case 'ZodBoolean': return 'true';
    case 'ZodArray': return '[…]';
    case 'ZodObject': return '{ x: 3, y: 4 }';
    case 'ZodUnion': return def.options?.[0] ? placeholder(def.options[0]) : '…';
    case 'ZodOptional': case 'ZodDefault': case 'ZodNullable': return def.innerType ? placeholder(def.innerType) : '…';
    case 'ZodEffects': return def.schema ? placeholder(def.schema) : '…';
    case 'ZodString': return "'…'";
    default: return '…';
  }
}

export function exampleOf(tool: string, shape: Record<string, ZodTypeAny>): string {
  if (EXAMPLES[tool]) return EXAMPLES[tool];
  const reqNames = new Set(requiredArgs(tool, shape));
  const req = Object.entries(shape).filter(([k]) => reqNames.has(k));
  return req.length ? `${tool} { ${req.map(([k, z]) => `${k}: ${placeholder(z)}`).join(', ')} }` : `${tool} {}`;
}

/** zod の検査の 1 件（v3 の ZodIssue の、ここで読む所だけ） */
export interface ArgIssue {
  code: string;
  path: (string | number)[];
  expected?: unknown;
  received?: unknown;
  options?: unknown[];
  minimum?: unknown;
  maximum?: unknown;
  type?: string;
  inclusive?: boolean;
  validation?: unknown;
  message?: string;
}

/** 正規表現の文字列の、読める書き方（よく使う形だけ。ほかは /…/） */
function regexForm(src: string): string {
  if (src === '^e_[0-9a-z]{6}$') return "'e_xxxxxx'";
  if (src === '^[a-z]$') return "'a'〜'z'";
  if (src === '^[sl][0-9]{1,6}$') return "'s12' / 'l1'";
  // fight の with（S16e: 正規表現のままでは、AI に読めない。SEASON.md §52.8）
  if (src.startsWith('^\\[?([a-z]|(core:)?[a-z][a-z0-9_]+)(,')) return "'a' / 'javelin' / 'javelin,throwing_knife'";
  if (src === '^([a-z]|(core:)?[a-z][a-z0-9_]+)$') return "'a' / 'javelin'";
  return `/${src}/`;
}

/** 引数の受ける形の短い文（断りの文に出す。ツール一覧の説明は変えない） */
export function formOf(z: ZodTypeAny | undefined, ja: boolean): string {
  const def = (z as unknown as { _def?: { typeName?: string; values?: unknown[]; options?: ZodTypeAny[]; innerType?: ZodTypeAny; schema?: ZodTypeAny; value?: unknown; checks?: { kind: string; value?: unknown; regex?: RegExp }[]; shape?: () => Record<string, ZodTypeAny>; type?: ZodTypeAny } } | undefined)?._def;
  switch (def?.typeName) {
    case 'ZodEnum': return (def.values ?? []).map((v) => `'${String(v)}'`).join(' / ');
    case 'ZodLiteral': return JSON.stringify(def.value);
    case 'ZodBoolean': return 'true / false';
    case 'ZodNumber': {
      const int = def.checks?.some((c) => c.kind === 'int');
      const min = def.checks?.find((c) => c.kind === 'min')?.value;
      const max = def.checks?.find((c) => c.kind === 'max')?.value;
      const range = min !== undefined && max !== undefined ? `${String(min)}〜${String(max)}` : min !== undefined ? (ja ? `${String(min)} 以上` : `>= ${String(min)}`) : max !== undefined ? (ja ? `${String(max)} 以下` : `<= ${String(max)}`) : '';
      const kind = int ? (ja ? '整数' : 'integer') : (ja ? '数' : 'number');
      return range ? `${kind}（${range}）` : kind;
    }
    case 'ZodString': {
      const re = def.checks?.find((c) => c.kind === 'regex')?.regex;
      return re ? regexForm(re.source) : (ja ? '文字列' : 'string');
    }
    case 'ZodObject': {
      const keys = def.shape ? Object.keys(def.shape()) : [];
      return keys.length ? `{ ${keys.map((k) => `${k}: …`).join(', ')} }` : '{ … }';
    }
    case 'ZodArray': return `[${def.type ? formOf(def.type, ja) : '…'}, …]`;
    case 'ZodUnion': return (def.options ?? []).map((o) => formOf(o, ja)).join(' / ');
    case 'ZodOptional': case 'ZodDefault': case 'ZodNullable': return def.innerType ? formOf(def.innerType, ja) : '…';
    case 'ZodEffects': return def.schema ? formOf(def.schema, ja) : '…';
    default: return '…';
  }
}

/** 断りの文に添える、渡された値（名前に token を含む引数の値は出さない。長い値は切る） */
function shownValue(path: (string | number)[], args: Record<string, unknown>): string | null {
  if (path.some((p) => /token/i.test(String(p)))) return null;
  let v: unknown = args;
  for (const p of path) v = v && typeof v === 'object' ? (v as Record<string | number, unknown>)[p] : undefined;
  if (v === undefined) return null;
  let s: string;
  try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/**
 * 引数の形の誤り（型・値の範囲・選べる値）の文（S16d）: どの引数が、どう違うか、受ける形は何か。1 件 1 文
 */
export function issueTexts(issues: readonly ArgIssue[], shape: Record<string, ZodTypeAny>, args: Record<string, unknown>, ja: boolean): string[] {
  const out: string[] = [];
  // 文にするのは、はじめの ISSUE_TEXT_MAX 件まで（S16e: 要素の多い配列は、要素ごとに誤りが出て、応答がふくらむ）
  for (const i of issues.slice(0, ISSUE_TEXT_MAX)) {
    const name = i.path.length ? i.path.join('.') : (ja ? '引数' : 'arguments');
    const val = shownValue(i.path, args);
    const got = val !== null ? (ja ? `（${val} が来た）` : ` (got ${val})`) : '';
    const top = typeof i.path[0] === 'string' ? shape[i.path[0]] : undefined;
    const form = i.path.length === 1 && top ? formOf(top, ja) : '';
    let what: string;
    switch (i.code) {
      case 'invalid_type':
        // 受ける形を後ろに書くときは、型の名前を重ねない（S16e）
        what = i.expected === 'integer' ? (ja ? 'は整数' : 'must be an integer')
          : form ? (ja ? 'の型が違う' : 'has the wrong type')
          : (ja ? `の型が違う（${clip(String(i.expected), 60)} を受ける）` : `has the wrong type (expects ${clip(String(i.expected), 60)})`);
        break;
      case 'invalid_enum_value':
        what = ja ? `は ${(i.options ?? []).map((o) => `'${String(o)}'`).join(' / ')} のどれか` : `must be one of ${(i.options ?? []).map((o) => `'${String(o)}'`).join(' / ')}`;
        break;
      case 'invalid_literal':
        what = ja ? `は ${JSON.stringify(i.expected)} だけ` : `must be ${JSON.stringify(i.expected)}`;
        break;
      case 'too_small':
        what = i.type === 'string' ? (ja ? `は ${String(i.minimum)} 文字以上` : `must be at least ${String(i.minimum)} characters`)
          : i.type === 'array' ? (ja ? `は ${String(i.minimum)} 個以上` : `needs at least ${String(i.minimum)} entries`)
          : (ja ? `は ${String(i.minimum)}${i.inclusive === false ? ' より大きい' : ' 以上'}` : `must be ${i.inclusive === false ? '>' : '>='} ${String(i.minimum)}`);
        break;
      case 'too_big':
        what = i.type === 'string' ? (ja ? `は ${String(i.maximum)} 文字まで` : `must be at most ${String(i.maximum)} characters`)
          : i.type === 'array' ? (ja ? `は ${String(i.maximum)} 個まで` : `takes at most ${String(i.maximum)} entries`)
          : (ja ? `は ${String(i.maximum)}${i.inclusive === false ? ' より小さい' : ' 以下'}` : `must be ${i.inclusive === false ? '<' : '<='} ${String(i.maximum)}`);
        break;
      case 'invalid_string':
      case 'invalid_union':
        what = ja ? 'の形が違う' : 'is not in an accepted form';
        break;
      default:
        what = ja ? 'の形が違う' : 'is not in an accepted form';
    }
    // 選べる値を書いた文には、受ける形を重ねない
    const formText = form && i.code !== 'invalid_enum_value' && i.code !== 'invalid_literal' ? (ja ? `。受ける形: ${form}` : `. Accepted: ${form}`) : '';
    out.push(`${clip(name, 60)} ${what}${got}${formText}`);
  }
  const rest = issues.length - ISSUE_TEXT_MAX;
  if (rest > 0) out.push(ja ? `ほか ${rest} 件` : `and ${rest} more`);
  return out;
}

/** 断りの文にする、形の誤りの数の上限（S16e） */
export const ISSUE_TEXT_MAX = 3;

/** 長い文字列を切る */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 引数の検査の前に断った呼び出しを、活動の記録に残すときの、短くした引数（S16e）。SDK の検査を通っていない値なので、長さの上限が効いていない
 * （20 万文字の thought・数千個の配列が、そのまま観戦に流れた）。文字列は 120 文字まで、ほかの値は JSON の 60 文字まで
 */
export function briefArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') out[k] = clip(v, 120);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else {
      let s: string;
      try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
      out[k] = s.length > 60 ? clip(s, 60) : v;
    }
  }
  return out;
}

/** 断りの文と記録に出す、知らない引数の名前（S16e: 数と長さを切る） */
export function briefNames(names: readonly string[], max = 5): string[] {
  const out = names.slice(0, max).map((n) => clip(n, 40));
  if (names.length > max) out.push(`…(+${names.length - max})`);
  return out;
}

/** 引数の一覧の文（要るもの・要らないもの）。共通の引数（player_token・thought・expect_seq と表示の 3 つ）は後ろにまとめる */
export function argListText(shape: Record<string, ZodTypeAny>, ja: boolean, tool = ''): string {
  const own = Object.keys(shape).filter((k) => !COMMON_ARGS.has(k));
  const required = new Set(requiredArgs(tool, shape));
  const req = own.filter((k) => required.has(k));
  const opt = own.filter((k) => !required.has(k));
  const com = [...COMMON_ARGS];
  return ja
    ? `要る: ${req.length ? req.join('・') : 'なし'}／要らない（任意）: ${opt.length ? opt.join('・') : 'なし'}${com.length ? `／共通: ${com.join('・')}` : ''}`
    : `required: ${req.length ? req.join(', ') : 'none'}; optional: ${opt.length ? opt.join(', ') : 'none'}${com.length ? `; common: ${com.join(', ')}` : ''}`;
}

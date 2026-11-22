// 引数の名前の断り（S1c §14.4 の 2。§8.9 の 1 を改める）: ツールの定義に無い名前の引数・要る引数が無いときは、MCP の SDK の入力の検査の前に受けて、
// ゲームの断りの形（code・hint に呼び方の例・valid_actions・turn・structuredContent）で返す。ツール一覧の「要る引数」は変えない（SDK の検査はそのまま後ろに残る）。
// 別名は足さない。引数の形が違う（型・値の範囲）は、今までどおり SDK の検査が断る
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

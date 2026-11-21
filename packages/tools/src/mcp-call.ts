// 試運転の道具（S0b。SEASON.md §6.2 の 6・§7）: MuseDungeon の MCP のツールを 1 回呼び、AI が受け取る文をそのまま出す。
// 使い方（PowerShell）: npm.cmd run call -- <tool> [key=value ...] ／ npm.cmd run call -- --tools（ツールの一覧。MCP のクライアントが AI に見せるもの）
//   bash・cmd では npm run call -- …。例: get_rules topic=season / new_run character_name=Aki class=scout / move dir=n /
//   travel_to to=stairs_down / travel_to to={"x":3,"y":4} / choose_perk option=1 / start_expedition offer=2 / extract confirm=true
// 値: そのツールの引数が文字列だけなら、そのまま文字列。ほかは JSON として読めれば JSON（数値・true・{"x":3,"y":4}・["a","b"]）、
//   読めなければ文字列。PowerShell が引用符を消した {x:3,y:4}・[javelin,throwing_knife] も読む。
// トークン: 応答に出るプレイヤーのトークン（player_token）とプロフィールのトークン（profile_token）はファイルに保存し、画面には伏せて出す。
//   保存先は MUSE_TOKEN_DIR（既定 trial-runs/tokens）の player-token.txt・profile-token.txt（ファイルごとに MUSE_TOKEN_FILE・MUSE_PROFILE_TOKEN_FILE で変えられる）。
//   プレイヤーごとに別の MUSE_TOKEN_DIR を使う。上書きする前のトークンは *.old.txt に 1 行ずつ残す。
//   保存したプレイヤーのトークンは、player_token を受け取るツールに自動で付く（resume_run も）。プロフィールのトークンは new_run・join_run に自動で付く
//   （シーズンの参加には、運用者から受け取ったプロフィールのトークンを profile-token.txt に置く）。
// つなぐ先: MUSE_MCP_URL（既定 http://127.0.0.1:<MUSE_PORT、無ければ 7777>/mcp）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

interface JsonSchema { type?: string | string[]; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; enum?: unknown[]; const?: unknown; properties?: Record<string, JsonSchema> }
interface ToolInfo { name: string; description?: string; inputSchema: JsonSchema }

export const USAGE = [
  '使い方（PowerShell）: npm.cmd run call -- <tool> [key=value ...]   （bash・cmd では npm run call -- …）',
  '  npm.cmd run call -- --tools   ツールの一覧（名前・説明・引数）',
  '  例: get_rules topic=season / new_run character_name=Aki / move dir=n / travel_to to=stairs_down / travel_to to={"x":3,"y":4} / choose_perk option=1',
  '  環境変数: MUSE_MCP_URL か MUSE_PORT（つなぐ先。既定 7777）、MUSE_TOKEN_DIR（トークンの置き場所。既定 trial-runs/tokens。プレイヤーごとに別にする）',
].join('\n');

/** その引数が文字列しか受け取らないか（JSON にしないでそのまま渡す） */
function stringOnly(s: JsonSchema | undefined): boolean {
  if (!s) return false;
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return alts.length > 0 && alts.every(stringOnly);
  if (s.type === 'string') return true;
  if (s.enum) return s.enum.every((v) => typeof v === 'string');
  return typeof s.const === 'string';
}

/** PowerShell が引用符を消した JSON（{x:3,y:4}・[javelin,core:throwing_knife]）を読めるようにする */
function relaxedJson(raw: string): unknown {
  const s = raw.trim();
  if (!/^[[{].*[\]}]$/s.test(s)) return undefined;
  // 鍵に引用符を付けるのは {…} だけ（[…] の中の core:javelin を鍵と読まない）
  const keyed = s.startsWith('{') ? s.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":') : s;
  const quoted = keyed.replace(/([[,:]\s*)([A-Za-z_][\w:.-]*)(?=\s*[,\]}])/g, (m, pre: string, word: string) => (['true', 'false', 'null'].includes(word) ? m : `${pre}"${word}"`));
  try { return JSON.parse(quoted); } catch { return undefined; }
}

/** key=value の値を、ツールの引数の形に合わせて読む */
export function parseValue(raw: string, schema?: JsonSchema): unknown {
  if (stringOnly(schema)) return raw;
  try { return JSON.parse(raw); } catch { /* 下へ */ }
  const r = relaxedJson(raw);
  return r === undefined ? raw : r;
}

/** key=value の並びを引数にする。形の合わないものは bad に入れる */
export function parsePairs(pairs: readonly string[], props: Record<string, JsonSchema> = {}): { args: Record<string, unknown>; bad: string[] } {
  const args: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) { bad.push(p); continue; }
    const k = p.slice(0, i);
    args[k] = parseValue(p.slice(i + 1), props[k]);
  }
  return { args, bad };
}

export interface TokenFiles { player: string; profile: string }

/** トークンの置き場所（環境変数で変えられる。相対パスは今の作業場所から） */
export function tokenFiles(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): TokenFiles {
  const dir = resolve(cwd, env.MUSE_TOKEN_DIR || 'trial-runs/tokens');
  return {
    player: env.MUSE_TOKEN_FILE ? resolve(cwd, env.MUSE_TOKEN_FILE) : resolve(dir, 'player-token.txt'),
    profile: env.MUSE_PROFILE_TOKEN_FILE ? resolve(cwd, env.MUSE_PROFILE_TOKEN_FILE) : resolve(dir, 'profile-token.txt'),
  };
}

function readToken(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const v = readFileSync(file, 'utf8').trim();
  return v || undefined;
}

/** 保存する（前と違うトークンなら、前のものを *.old.txt に 1 行足す） */
function saveToken(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const prev = readToken(file);
  if (prev && prev !== token) appendFileSync(file.replace(/(\.txt)?$/, '.old.txt'), `${prev}\n`);
  writeFileSync(file, `${token}\n`);
}

/** 文の中のトークンを伏せる */
export function maskTokens(text: string, secrets: readonly { value: string | undefined; file: string }[], cwd = process.cwd()): string {
  let out = text;
  for (const s of secrets) {
    if (!s.value || s.value.length < 8) continue;
    out = out.split(s.value).join(`［伏せた: ${relative(cwd, s.file) || s.file}］`);
  }
  return out;
}

export async function mcpCall(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, print: (s: string) => void = console.log): Promise<number> {
  const [tool, ...pairs] = argv;
  if (!tool || tool === '--help' || tool === '-h') { print(USAGE); return tool ? 0 : 1; }
  const url = env.MUSE_MCP_URL || `http://127.0.0.1:${env.MUSE_PORT || '7777'}/mcp`;
  const files = tokenFiles(env);
  const client = new Client({ name: 'muse-call', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  } catch (e) {
    print(`サーバーにつながらない（${url}）: ${(e as Error).message}。MUSE_MCP_URL か MUSE_PORT を確かめる / cannot connect`);
    return 1;
  }
  try {
    const { tools } = (await client.listTools()) as { tools: ToolInfo[] };
    // --tools: MCP のクライアントが AI に見せるツールの一覧（名前・説明・引数の JSON Schema）
    if (tool === '--tools') {
      for (const t of tools) print(`## ${t.name}\n${t.description ?? ''}\n${JSON.stringify(t.inputSchema)}\n`);
      return 0;
    }
    const info = tools.find((t) => t.name === tool);
    const props = info?.inputSchema.properties ?? {};
    const { args, bad } = parsePairs(pairs, props);
    if (bad.length) { print(`key=value の形でない引数: ${bad.join(' ')}\n${USAGE}`); return 1; }
    const playerToken = readToken(files.player);
    const profileToken = readToken(files.profile);
    // 保存したトークンを付ける（引数で渡したものが先）
    if (playerToken && 'player_token' in props && args.player_token === undefined) args.player_token = playerToken;
    if (profileToken && (tool === 'new_run' || tool === 'join_run') && 'profile_token' in props && args.profile_token === undefined) args.profile_token = profileToken;
    let r: { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
    try {
      r = (await client.callTool({ name: tool, arguments: args })) as typeof r;
    } catch (e) {
      print(`呼び出しのエラー: ${(e as Error).message}`);
      return 1;
    }
    const sc = r.structuredContent ?? {};
    const newPlayer = typeof sc.player_token === 'string' ? sc.player_token : undefined;
    const newProfile = typeof sc.profile_token === 'string' ? sc.profile_token : undefined;
    if (newPlayer) saveToken(files.player, newPlayer);
    if (newProfile) saveToken(files.profile, newProfile);
    const secrets = [
      { value: newPlayer, file: files.player }, { value: playerToken, file: files.player },
      { value: newProfile, file: files.profile }, { value: profileToken, file: files.profile },
      { value: typeof args.player_token === 'string' ? args.player_token : undefined, file: files.player },
      { value: typeof args.profile_token === 'string' ? args.profile_token : undefined, file: files.profile },
    ];
    const text = (r.content ?? []).filter((c) => c.type === 'text' && c.text !== undefined).map((c) => c.text!).join('\n');
    print(maskTokens(text, secrets));
    return r.isError ? 1 : 0;
  } finally {
    await client.close();
  }
}

// npm run call -- … から呼ばれたときだけ動く（テストでは import だけする）
const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (/mcp-call\.ts$/.test(entry)) process.exitCode = await mcpCall(process.argv.slice(2));

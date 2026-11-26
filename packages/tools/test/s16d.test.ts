// S16d（SEASON.md §70 の検査の指摘）: MCP の引数の形の誤り（型・値の範囲・選べる値）も、ほかの断りと同じゲームの形
// （ok: false・error.code bad_request・どの引数がどう違うか・例・valid_actions・turn）で返し、観戦の「AI の呼び出しの記録」に残す。
// ツール一覧の inputSchema（AI が読む引数の説明）は変えない
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { buildCatalog } from '@muse/content';
import type { ExpeditionOffer } from '@muse/shared';
import { bountyForecastText, gearVsArmorText, guardianForecastText, offerGuardianHp, projectPlayerView } from '@muse/shared';
import { content } from './v33duel';

const catalog = buildCatalog(content);
// 画面の部品（.tsx）は、ここの型の検査（jsx なし）の外から読む（vitest は preact の jsx で変換する）
type Card = (p: Record<string, unknown>) => unknown;
const CARDS_PATH = '../../client/src/ui/campCards.tsx';
const cards = () => import(/* @vite-ignore */ CARDS_PATH) as Promise<{ ObjectiveCard: Card; EndlessCard: Card }>;

/** 関数の部品を呼んで、できた木の文字と、押せるもの（onClick）を集める（DOM を使わない。部品は hooks を使わない） */
type VNodeLike = { type?: unknown; props?: Record<string, unknown> } | string | number | boolean | null | undefined | VNodeLike[];
function walk(n: VNodeLike, out: { text: string[]; clicks: { cls: string; fn: () => void }[] }): void {
  if (n === null || n === undefined || typeof n === 'boolean') return;
  if (typeof n === 'string' || typeof n === 'number') { out.text.push(String(n)); return; }
  if (Array.isArray(n)) { for (const c of n) walk(c, out); return; }
  const props = n.props ?? {};
  if (typeof n.type === 'function') { walk((n.type as (p: unknown) => VNodeLike)(props), out); return; }
  if (typeof props.onClick === 'function') out.clicks.push({ cls: String(props.class ?? ''), fn: props.onClick as () => void });
  if (typeof props.title === 'string') out.text.push(props.title);
  walk(props.children as VNodeLike, out);
}
function rendered(el: VNodeLike) {
  const out = { text: [] as string[], clicks: [] as { cls: string; fn: () => void }[] };
  walk(el, out);
  return { text: out.text.join('\n'), clicks: out.clicks };
}

describe('S16d C6: the new objective card shows what the old offer card showed', () => {
  it('bounty forecast, vault, warden, the warden on the way, the gear estimate, waking the floor; pressing the chosen card again sends nothing', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await m.createRun({ name: 'Card', seed: 's16d-card', classId: 'core:warrior', controller: { kind: 'human', label: 't' } });
    if ('error' in r) throw new Error(r.error.message);
    const { ObjectiveCard, EndlessCard } = await cards();
    try {
      const view = projectPlayerView(r.session.world, r.port.playerId);
      const rules = catalog.rules;
      const name = { ja: 'ギルガ', en: 'Girga' };
      const bounty: ExpeditionOffer = { index: 1, points: 700, relicGuarded: false, slot: 'ambitious', traits: [], multiplierPct: 100, objective: { type: 'slay_bounty', targetDepth: 3 },
        bounty: { kind: 'core:orc_brute', name, affixes: [], kindName: { ja: 'オークの荒くれ', en: 'orc brute' }, affixNames: [], hp: 20, maxHit: 10, armor: 1 }, scar: 2 } as ExpeditionOffer;
      const vault: ExpeditionOffer = { index: 2, points: 500, relicGuarded: false, slot: 'standard', traits: [], multiplierPct: 100, objective: { type: 'open_vault', targetDepth: 6 }, vault: true,
        passesWarden: { depth: 5, name: { ja: 'ヴォキ', en: 'Voki' }, types: [] } } as ExpeditionOffer;
      const warden: ExpeditionOffer = { index: 3, points: 900, relicGuarded: false, slot: 'ambitious', traits: [], multiplierPct: 100, objective: { type: 'slay_warden', targetDepth: 5 },
        warden: { depth: 5, name: { ja: 'ヴォキ', en: 'Voki' }, types: ['core:armored'] }, guardian: { rank: 3, traits: [], armor: 7, types: ['core:armored'] } } as ExpeditionOffer;
      const relic: ExpeditionOffer = { index: 1, points: 600, relicGuarded: true, slot: 'standard', traits: [], multiplierPct: 100, objective: { type: 'retrieve_relic', targetDepth: 4 },
        guardian: { rank: 2, traits: [], armor: 2 } } as ExpeditionOffer;
      const card = (o: ExpeditionOffer, chosen = false, onSelect: (n: number) => void = () => undefined) =>
        rendered(ObjectiveCard({ o, rules, level: view.self.level, view, catalog, chosen, selectLabel: 'この目的にする', onSelect }) as unknown as VNodeLike);

      const b = card(bounty).text;
      expect(b).toContain('賞金首「ギルガ」');
      expect(b).toContain(bountyForecastText('ja', bounty.bounty!));
      expect(b).toContain(gearVsArmorText('ja', catalog, view, 1, Math.max(1, 20 - 2)));
      expect(b).toContain('傷跡で体力 −2');
      const v = card(vault).text;
      expect(v).toContain('鍵を持つ敵が階にいる');
      expect(v).toContain('途中の地下5階で大守護者を倒す');
      const w = card(warden).text;
      expect(w).toContain('大守護者「ヴォキ」');
      expect(w).toContain(guardianForecastText('ja', warden.guardian!));
      expect(w).toContain(gearVsArmorText('ja', catalog, view, 7, offerGuardianHp(view, warden), ['core:armored']));
      const rl = card(relic).text;
      expect(rl).toContain('拾うと、階の敵が起きる');
      expect(rl).toContain('遺物を持ち帰る（守護者付き）');
      // 推奨のレベルの説明（S16d C2）と、段の言葉が無いこと
      expect(rl).toContain('その深さに着いたときの、レベルの目安');
      for (const word of ['届いている', '背伸び']) expect(rl).not.toContain(word);
      expect(rl.split('\n')).not.toContain('危険');

      // 選んだ札を押し直しても、選び直さない（支度で prepare を送り直さない）。選んでいない札は選ぶ
      const sent: number[] = [];
      const press = (o: ExpeditionOffer, chosen: boolean) => card(o, chosen, (n) => sent.push(n)).clicks.find((c) => c.cls.includes('ocard-pick'))!.fn();
      press(bounty, true);
      expect(sent).toEqual([]);
      press(bounty, false);
      expect(sent).toEqual([1]);
      let endless = 0;
      const e = (chosen: boolean) => rendered(EndlessCard({ chosen, selectLabel: 'x', onSelect: () => { endless++; } }) as unknown as VNodeLike).clicks.find((c) => c.cls.includes('ocard-pick'))!.fn();
      e(true);
      expect(endless).toBe(0);
      e(false);
      expect(endless).toBe(1);
    } finally {
      m.closeAll();
    }
  });
});

type Res = { content: { text: string }[]; isError?: boolean; structuredContent?: { ok: boolean; error: { code: string; message: string; hint: string }; valid_actions: string[]; turn?: unknown } };

describe('S16d: argument shape errors get the game-form refusal', () => {
  it('a fractional hp_floor, a misspelt mode and a wrong-typed to: ok false, which argument and how, an example, valid_actions, turn; recorded for spectators without tokens', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const listBefore = JSON.stringify((await client.listTools()).tools.map((t) => [t.name, t.inputSchema]));
      const nr = await client.callTool({ name: 'new_run', arguments: { character_name: 'Shape', objective: 'reach_depth' } }) as unknown as { structuredContent: { player_token: string } };
      const token = nr.structuredContent.player_token;
      const seen: { tool: string; args: string; text: string }[] = [];
      const orig = m.recordActivity.bind(m);
      m.recordActivity = (runId, a) => { seen.push({ tool: a.tool, args: JSON.stringify(a.args), text: a.text }); orig(runId, a); };

      // 小数の hp_floor
      const frac = await client.callTool({ name: 'travel_to', arguments: { to: 'stairs_down', mode: 'flee', hp_floor: 0.5, player_token: token } }) as unknown as Res;
      expect(frac.isError).toBe(true);
      expect(frac.structuredContent?.ok).toBe(false);
      expect(frac.structuredContent?.error.code).toBe('bad_request');
      expect(frac.structuredContent?.error.message).toContain('travel_to の引数の形が違う: hp_floor は整数（0.5 が来た）。受ける形: 整数（0 以上）');
      expect(frac.structuredContent?.error.hint).toContain("travel_to { to: 'stairs_down' }");
      expect(frac.structuredContent?.error.hint).toContain('要る: to');
      expect(frac.structuredContent?.valid_actions.length).toBeGreaterThan(0);
      expect(frac.structuredContent?.turn).toBeDefined();
      expect(frac.content[0].text).toContain('Error [bad_request]');
      expect(frac.content[0].text).not.toContain('Input validation error');

      // 綴り違いの mode
      const typo = await client.callTool({ name: 'travel_to', arguments: { to: 'stairs_down', mode: 'flea' } }) as unknown as Res;
      expect(typo.structuredContent?.error.code).toBe('bad_request');
      expect(typo.structuredContent?.error.message).toContain("mode は 'careful' / 'steady' / 'flee' のどれか（\"flea\" が来た）");

      // 型の合わない to（数）
      const to = await client.callTool({ name: 'travel_to', arguments: { to: 5 } }) as unknown as Res;
      expect(to.structuredContent?.error.code).toBe('bad_request');
      expect(to.structuredContent?.error.message).toContain('to の形が違う（5 が来た）');
      expect(to.structuredContent?.error.message).toContain("受ける形: { x: …, y: … } / 'stairs_down' / 'stairs_up' / 'e_xxxxxx'");

      // 観戦の「AI の呼び出しの記録」に残る（トークンは残さない）
      const bad = seen.filter((s) => s.tool === 'travel_to');
      expect(bad).toHaveLength(3);
      expect(bad[0].text).toContain('bad_request');
      expect(bad[0].args).toContain('"hp_floor":0.5');
      expect(seen.some((s) => s.args.includes(token) || s.text.includes(token))).toBe(false);
      m.recordActivity = orig;

      // 手番は使わない: 正しい呼び出しは、そのまま通る
      const ok = await client.callTool({ name: 'travel_to', arguments: { to: 'stairs_down', mode: 'flee', hp_floor: 1 } }) as unknown as Res;
      expect(ok.structuredContent?.error?.code ?? 'ok').not.toBe('bad_request');

      // ツール一覧（AI が読む引数の説明）は変わらない
      const listAfter = JSON.stringify((await client.listTools()).tools.map((t) => [t.name, t.inputSchema]));
      expect(listAfter).toBe(listBefore);
    } finally {
      await client.close();
      m.closeAll();
      await new Promise<void>((r2) => app.server.close(() => r2()));
    }
  });

  it('unbound connection: the same body and structuredContent without valid_actions', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      const r = await client.callTool({ name: 'get_rules', arguments: { topic: 'nope' } }) as unknown as Res;
      expect(r.isError).toBe(true);
      expect(r.structuredContent?.ok).toBe(false);
      expect(r.structuredContent?.error.code).toBe('bad_request');
      expect(r.structuredContent?.error.message).toContain('get_rules の引数の形が違う: topic は');
    } finally {
      await client.close();
      m.closeAll();
      await new Promise<void>((r2) => app.server.close(() => r2()));
    }
  });

  // S16e（S16d の検査の指摘）: ここは SDK の検査より前なので、値の長さの上限が効いていない。応答と、観戦に流す記録を、ふくらませない
  it('huge values, thousands of bad elements and many unknown names: the reply and the spectator record stay small', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await client.callTool({ name: 'new_run', arguments: { character_name: 'Big', objective: 'reach_depth' } });
      const seen: { tool: string; args: string; text: string }[] = [];
      const orig = m.recordActivity.bind(m);
      m.recordActivity = (runId, a) => { seen.push({ tool: a.tool, args: JSON.stringify(a.args), text: a.text }); orig(runId, a); };
      const size = (r: Res) => JSON.stringify(r).length;

      // 20 万文字の thought（上限 280 文字）
      const long = await client.callTool({ name: 'wait', arguments: { thought: 'x'.repeat(200_000) } }) as unknown as Res;
      expect(long.structuredContent?.error.code).toBe('bad_request');
      expect(size(long)).toBeLessThan(20_000);

      // 5000 個の、型の違う要素: 文にするのは、はじめの 3 件と「ほか N 件」
      const many = await client.callTool({ name: 'collect', arguments: { kinds: Array.from({ length: 5000 }, () => 1) } }) as unknown as Res;
      expect(many.structuredContent?.error.code).toBe('bad_request');
      expect(many.structuredContent?.error.message).toMatch(/ほか \d+ 件/);
      expect(size(many)).toBeLessThan(20_000);

      // 200 個の、長い、知らない名前
      const names = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${'n'.repeat(300)}${i}`, 1]));
      const unk = await client.callTool({ name: 'wait', arguments: names }) as unknown as Res;
      expect(unk.structuredContent?.error.code).toBe('bad_request');
      expect(size(unk)).toBeLessThan(20_000);

      // 観戦に流す記録も、短い（3 回とも残る）
      expect(seen).toHaveLength(3);
      for (const s of seen) expect(s.args.length + s.text.length).toBeLessThan(6000);
      m.recordActivity = orig;

      // fight の with の受ける形は、正規表現でなく、読める書き方
      const w = await client.callTool({ name: 'fight', arguments: { target: 'e_000000', with: 'X!' } }) as unknown as Res;
      expect(w.structuredContent?.error.message).toContain("'javelin'");
      expect(w.structuredContent?.error.message).not.toContain('[a-z]');
    } finally {
      await client.close();
      m.closeAll();
      await new Promise<void>((r2) => app.server.close(() => r2()));
    }
  });
});

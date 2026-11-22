// 追従だけの観戦（follow_only・開催中のシーズンのラン）でも、追従の相手に届いた出来事を view の枠で送る（演出・音・メッセージ）。
// マクロの途中の手は 1 枚にまとめない。ほかの者にしか届かない出来事と、トークンは枠に入らない
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import type { App, PlayerPort } from '@muse/server';
import type { Command, GameEvent, ServerMsg } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 'wft';

async function listen(m: SessionManager): Promise<{ app: App; port: number }> {
  const app = createApp(m, m.config);
  await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
  return { app, port: (app.server.address() as AddressInfo).port };
}

/** 観戦の WS を開き、最初の view が届くまで待つ。msgs に届いたものがたまる */
async function openSpectator(port: number, hello: Record<string, unknown>): Promise<{ msgs: ServerMsg[]; raw: string[]; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: ServerMsg[] = [];
  const raw: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no first view')), 3000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'spectator', ...hello })));
    ws.on('message', (data) => {
      raw.push(String(data));
      const m = JSON.parse(String(data)) as ServerMsg;
      msgs.push(m);
      if (m.t === 'view') { clearTimeout(timer); resolve(); }
      if (m.t === 'error') { clearTimeout(timer); reject(new Error(m.error.message)); }
    });
    ws.on('error', reject);
  });
  return { msgs, raw, close: () => ws.close() };
}

const settle = () => new Promise((r) => setTimeout(r, 200));
const views = (msgs: ServerMsg[]) => msgs.filter((m): m is Extract<ServerMsg, { t: 'view' }> => m.t === 'view');

describe('follow-only spectating sends the perceived events of the followed player, one frame per step', () => {
  it('season run: frames carry exactly what the player perceived; a macro is not merged into one frame; no tokens', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    m.seasons.store.open({ id: SID, name: '追従の試し', seed: 'wft-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite(SID, 'Aya', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const a = await m.createRun({ name: 'Aya', controller: agent, season: SID, profileToken: inv.token! });
    if ('error' in a) throw new Error(a.error.message);
    const { app, port } = await listen(m);
    try {
      // 同じ機械から（運用者）: シーズンのランは追従だけ
      const sp = await openSpectator(port, { runId: a.session.runId, mode: 'follow' });
      const first = views(sp.msgs)[0];
      // 接続した直後の最初の枠は、出来事なしの今の view
      expect(first.events).toEqual([]);
      expect(first.view.playerId).toBe(a.playerId);
      const seq0 = first.view.seq;

      const r1 = await a.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
      expect(r1.ok).toBe(true);
      const before = a.session.world.seq;
      const r2 = await a.port.act({ type: 'explore' } as Command, { source: 'bot' });
      expect(r2.ok).toBe(true);
      const after = a.session.world.seq;
      await settle();
      sp.close();

      const frames = views(sp.msgs).slice(1);
      expect(sp.msgs.some((x) => x.t === 'snapshot' || x.t === 'events')).toBe(false);
      // 枠の出来事を並べると、その人の PlayerPort が受け取るもの（遊ぶ画面の WS と同じ中身）とちょうど同じ
      const got = frames.flatMap((f) => f.events);
      const want = a.port.perceivedSince(seq0);
      expect(got.length).toBeGreaterThan(0);
      expect(got.map((e) => e.seq)).toEqual(want.map((e) => e.seq));
      expect(JSON.stringify(got)).toBe(JSON.stringify(want));
      // マクロの手: 自分が動いた命令の確定ごとに、その確定の時点の view の枠がある（1 枚にまとまらない）
      const commits = new Map<number, GameEvent[]>();
      for (const ev of a.session.history) {
        if (ev.seq <= before || ev.seq > after || ev.cause === null) continue;
        const list = commits.get(ev.cause) ?? [];
        list.push(ev);
        commits.set(ev.cause, list);
      }
      const selfId = a.session.world.players[a.playerId].entityId;
      const moved = [...commits.values()].filter((evs) => evs.some((e) => e.type === 'entity_moved' && (e as { id?: string }).id === selfId));
      expect(moved.length).toBeGreaterThan(2);
      const frameSeqs = new Set(frames.map((f) => f.view.seq));
      for (const evs of moved) expect(frameSeqs.has(evs[evs.length - 1].seq)).toBe(true);
      // 枠の view の seq は戻らない
      for (let i = 1; i < frames.length; i++) expect(frames[i].view.seq).toBeGreaterThanOrEqual(frames[i - 1].view.seq);
      // トークン（プレイヤーのトークンも、招かれたプロフィールのトークンも）は、どの枠にも無い
      for (const s of sp.raw) {
        expect(s.includes(a.token)).toBe(false);
        expect(s.includes(inv.token!)).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  it('coop run with spectatorPolicy=follow_only: events only the other player perceives are not in the frames', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 300, spectatorPolicy: 'follow_only' }));
    const a = await m.createRun({ name: 'A', mode: 'coop', seed: 'wft-coop-1', controller: agent });
    if ('error' in a) throw new Error(a.error.message);
    const b = await m.joinRun(a.session.runId, { name: 'B', classId: 'core:scout', controller: { kind: 'human', label: 'b' } });
    if ('error' in b) throw new Error(b.error.message);
    const { app, port } = await listen(m);
    try {
      const sp = await openSpectator(port, { runId: a.session.runId, mode: 'follow', follow: a.playerId });
      const seq0 = views(sp.msgs)[0].view.seq;
      const started = await a.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
      expect(started.ok).toBe(true);
      // 交互に待つ。B の思考（B 本人にだけ届く）を記録に残す
      const SECRET = 'B-だけの思考-7f3a';
      const ports: Record<string, PlayerPort> = { a: a.port, b: b.port };
      for (let i = 0; i < 8; i++) {
        const who = ports.b.view().status === 'your_turn' ? 'b' : ports.a.view().status === 'your_turn' ? 'a' : null;
        if (!who) { await new Promise((r) => setTimeout(r, 20)); continue; }
        await ports[who].act({ type: 'wait' }, { source: 'bot', thought: who === 'b' ? SECRET : 'A の思考' });
      }
      await settle();
      sp.close();
      // B の思考は記録にある（確かめの前提）が、A を追う枠には無い
      expect(a.session.history.some((e) => e.type === 'thought' && (e as { text?: string }).text === SECRET)).toBe(true);
      for (const s of sp.raw) {
        expect(s.includes(SECRET)).toBe(false);
        expect(s.includes(a.token)).toBe(false);
        expect(s.includes(b.token)).toBe(false);
      }
      const frames = views(sp.msgs).slice(1);
      const got = frames.flatMap((f) => f.events);
      const want = a.port.perceivedSince(seq0);
      expect(got.length).toBeGreaterThan(0);
      expect(JSON.stringify(got)).toBe(JSON.stringify(want));
      expect(frames.every((f) => f.view.playerId === a.playerId)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

// S10（SEASON.md §58.4）: 拠点の冒険者の札に要る値。GET /api/profile の seasons（そのプロフィールが招かれたシーズン: 招いたときの表示名・使った予算・
// ランの数・倒れたか）。そのプロフィールの鍵でだけ返り、ほかのプロフィールの招きは入らない。応答に鍵を出さない。engine と出来事の形は変えていない
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { EVENT_VERSION } from '@muse/shared';
import type { ProfileSeasonEntry } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };

describe('S10 §58.4: what the hub card needs from GET /api/profile', () => {
  it('lists the seasons the key\'s profile is invited to, with the invited name, budget used and runs; nothing for another profile', async () => {
    expect(ENGINE_VERSION).toBe('0.49.0');
    expect(EVENT_VERSION).toBe(37);
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    m.seasons.store.open({ id: 's10a', name: 'S10試し', seed: 's10-season-a', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 4000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite('s10a', 'ミナ', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const tok = inv.token!;
    // 招かれていないプロフィール（シーズンでないランから）
    const other = await m.createRun({ name: 'ヨソ', seed: 's10-other', controller: agent });
    if ('error' in other) throw new Error(other.error.message);
    const otherTok = other.profile.token!;
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const get = async (t?: string) => { const res = await fetch(`${base}/api/profile`, t ? { headers: { authorization: `Bearer ${t}` } } : undefined); return { status: res.status, text: await res.text() }; };
    try {
      let r = await get(tok);
      expect(r.status).toBe(200);
      let body = JSON.parse(r.text) as { name: string; seasons: ProfileSeasonEntry[] };
      expect(body.seasons).toEqual([{ id: 's10a', seasonName: 'S10試し', name: 'ミナ', status: 'open', budget: 4000, used: 0, runs: 0, died: false }]);
      expect(r.text).not.toContain(tok);
      // ほかのプロフィール: 招かれていなければ空（ほかの者の招きは入らない）
      r = await get(otherTok);
      expect((JSON.parse(r.text) as { seasons: unknown[] }).seasons).toEqual([]);
      expect(r.text).not.toContain('ミナ');
      // 鍵が無ければ 401（同じ機械からでも）
      expect((await get()).status).toBe(401);
      // ランを始めると、ランの数が増える
      const run = await m.createRun({ name: 'ミナ', controller: agent, season: 's10a', profileToken: tok });
      if ('error' in run) throw new Error(run.error.message);
      body = JSON.parse((await get(tok)).text) as { name: string; seasons: ProfileSeasonEntry[] };
      expect(body.seasons[0]).toMatchObject({ id: 's10a', name: 'ミナ', runs: 1, died: false, status: 'open' });
      // 持ち主の口の一覧も、その鍵の冒険者のランとして返る（拠点の札の行）
      const own = await fetch(`${base}/api/owner/runs`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json()) as { runs: { runId: string; mine?: boolean; season?: { participant?: string } }[] };
      expect(own.runs.find((x) => x.runId === run.session.runId)).toMatchObject({ mine: true, season: { participant: 'ミナ' } });
    } finally {
      await new Promise<void>((res) => app.server.close(() => res()));
      m.closeAll();
    }
  });
});

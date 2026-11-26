// S16b（SEASON.md §70.4 の 4）のテスト: 図鑑のタブの運用者の口 GET /api/ops/codex。
// ほかの PC から（接続元・Host・Origin。鍵を付けても）は断る／POST は受けない／同じ PC からは、プロフィールの全員の図鑑と実績だけ
// （鍵・そのハッシュ・シード・ランの ID は応答に無い。図鑑も実績も無いプロフィールは載せない。覚えさせない: no-store）
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { emptyCodex } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };

type R = { status: number; text: string; json: Record<string, any> | null; headers: http.IncomingHttpHeaders };
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<R> {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (x) => {
      const cs: Buffer[] = [];
      x.on('data', (c) => cs.push(c as Buffer));
      x.on('end', () => { const text = Buffer.concat(cs).toString('utf8'); let json: R['json'] = null; try { json = JSON.parse(text); } catch { /* JSON でない */ } res({ status: x.statusCode!, text, json, headers: x.headers }); });
    });
    r.on('error', rej);
    r.end();
  });
}

describe('S16b §70.4 の 4: the operator codex endpoint', () => {
  it('only from the server PC; returns each profile\'s codex and feats only (no key, hash, seed or run id); profiles with nothing are left out', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const seed = 's16b-secret-seed-1234';
    const a = await m.createRun({ name: 'ミュゼ美', seed, controller: agent });
    if ('error' in a) throw new Error(a.error.message);
    const b = await m.createRun({ name: 'ツバキ', seed: `${seed}-2`, controller: agent });
    if ('error' in b) throw new Error(b.error.message);
    const keyA = a.profile.token!;
    // ミュゼ美だけ、種族を 1 つ見つけたことにする（図鑑はプロフィールの記録から作る）
    const pa = m.profiles.store.get(a.profile.id)!;
    const sp = content.lists.monsters[0].id;
    const codex = { ...emptyCodex(), species: { [sp]: { met: 2, kills: 1, abilities: [] } } };
    if (pa.runs.length) pa.runs[0].codex = codex;
    else pa.runs.push({ runId: a.session.runId, character: 'ミュゼ美', classId: 'core:warrior', legacy: false, legacyKinds: 0, startedAt: 1, endedAt: null, status: 'active', end: null, deathCause: null, level: 1, banked: 0, deepest: 1, expeditions: 0, completed: 0, withdrawn: 0, wardens: [], streakMax: 0, best: { depth: null, banked: null, margin: null }, codex });
    // ツバキのプロフィールは、図鑑も実績も空にしておく
    const pb = m.profiles.store.get(b.profile.id)!;
    for (const r of pb.runs) r.codex = emptyCodex();
    pb.feats = [];
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const P = (app.server.address() as AddressInfo).port;
    try {
      // ほかの PC から（接続元・DNS の付け替え・別の origin・鍵つき）: 403
      for (const h of <Record<string, string>[]>[{ 'x-forwarded-for': '203.0.113.9' }, { host: `rebind.evil.example:${P}` }, { origin: 'http://evil.example' }, { 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${keyA}` }]) {
        const r = await raw(P, 'GET', '/api/ops/codex', h);
        expect(r.status).toBe(403);
        expect(r.text).not.toContain('ミュゼ美');
      }
      // 読むだけの口: POST は受けない
      expect((await raw(P, 'POST', '/api/ops/codex', { 'content-type': 'application/json' })).status).toBe(405);
      // 同じ PC から: 図鑑のあるプロフィールだけ。形は GET /api/profile/records の codex・feats と同じ
      const ok = await raw(P, 'GET', '/api/ops/codex?locale=ja', { origin: `http://127.0.0.1:${P}` });
      expect(ok.status).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      const profiles = ok.json!.profiles as { profileId: string; name: string; codex: any; feats: any }[];
      expect(profiles.map((x) => x.profileId)).toEqual([a.profile.id]);
      expect(Object.keys(profiles[0]).sort()).toEqual(['codex', 'feats', 'name', 'profileId']);
      const species = profiles[0].codex.categories.find((c: { id: string }) => c.id === 'species');
      expect(species.entries.map((e: { id: string }) => e.id)).toEqual([sp]);
      const viaKey = await raw(P, 'GET', '/api/profile/records?locale=ja', { authorization: `Bearer ${keyA}` });
      expect(profiles[0].codex).toEqual(viaKey.json!.records.codex);
      expect(profiles[0].feats).toEqual(viaKey.json!.records.feats);
      // 鍵・そのハッシュ・シード・ランの ID・1 人ずつの記録は、応答に無い
      const hashA = (pa as unknown as { tokenHash: string }).tokenHash;
      for (const secret of [keyA, b.profile.token!, hashA, seed, a.session.runId, b.session.runId]) expect(ok.text).not.toContain(secret);
      for (const word of ['token', 'seed', 'recent', 'deepest', 'banked', 'runId']) expect(ok.text).not.toContain(`"${word}"`);
      // 英語
      const en = await raw(P, 'GET', '/api/ops/codex?locale=en');
      expect(en.json!.profiles[0].codex.categories[0].name).toBe('Species');
    } finally {
      await app.close();
    }
  });
});

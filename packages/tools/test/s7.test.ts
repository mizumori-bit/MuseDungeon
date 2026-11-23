// S7（SEASON.md §52・§53）のテスト: 区切りの覚え書き（A）・観戦の直前の命令（B）・呼び出しの時間の控え（C）・
// explore toward の幅（D）・表示と文（F）。見込みの数え方（E）は s7e.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { loadConfig, RunSession, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { buildObservation, checkpointStep, CHECKPOINT_NOTES, formatObservationText, projectPlayerView } from '@muse/shared';
import type { CheckpointLedger, Command } from '@muse/shared';
import { playWithPort } from '../src/bot';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });

// ---------------- A: 区切りの覚え書き（§52.2） ----------------

describe('S7 §52.2 の 1: the camp observation ends with the fixed break paragraph, the note template and the notes (newest 8)', () => {
  it('shows the paragraph and the template with no notes; with notes, the newest 8 with their numbers; the notes line is in the actions', async () => {
    const m = manager();
    const r = await m.createRun({ name: 'N', seed: 's7-camp-1', controller: agent });
    if ('error' in r) throw new Error(r.error.message);
    const port = r.port;
    expect(port.view().status).toBe('at_camp');
    const o0 = port.observe();
    expect(o0.observation.checkpoint?.notes).toEqual([]);
    expect(o0.observation.checkpoint?.template).toEqual(['次のねらい', '分かったこと（相手・品・地形）', 'まだ分からないこと', '前にやめたことと、その根拠（今も成り立つか）']);
    expect(o0.text).toContain('区切り: ここは遠征の区切り。今の状態は、この表示が正本（持ち物・装備・能力・順位・次の候補）。これより前の経過は、次の判断に要らない。次の遠征に持ち越したいことは、notes に書けば、キャンプと resume_run で返す');
    expect(o0.text).toContain('覚え書きの定型（項目の名前だけ。中身はあなたが書く）: 次のねらい／分かったこと（相手・品・地形）／まだ分からないこと／前にやめたことと、その根拠（今も成り立つか）');
    expect(o0.text).toContain('書き方: notes { add: "次のねらい: …" }');
    // 「この表示が正本」と言うので、能力と所持品もキャンプの表示にある
    expect(o0.text).toMatch(/能力: 命中\+\d+ ダメージ/);
    expect(o0.text).toMatch(/所持品 \(\d+\/\d+、\* は装備中\)/);
    expect(o0.observation.valid_actions.some((l) => l.startsWith('notes { add: "次のねらい: …" }'))).toBe(true);
    // 区切りの段は、観測の終わり（できることの後）
    const lines = o0.text.split('\n');
    expect(lines.findIndex((l) => l.startsWith('区切り: '))).toBeGreaterThan(lines.findIndex((l) => l.startsWith('できること: ')));
    for (let i = 0; i < 10; i++) expect((await act(port, { type: 'note', add: `分かったこと: メモ ${i}` })).ok).toBe(true);
    const o1 = port.observe();
    const c = o1.observation.checkpoint!;
    expect(c.notes_total).toBe(10);
    expect(c.notes.length).toBe(CHECKPOINT_NOTES);
    expect(c.notes.map((n) => n.index)).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    expect(o1.text).toContain('あなたのメモ（新しい順に 8 件。全部で 10 件は notes で）:');
    expect(o1.text).toContain('- 9: 分かったこと: メモ 9');
    expect(o1.text).not.toContain('- 1: 分かったこと: メモ 1');
    // 英語も同じ形
    const en = formatObservationText(buildObservation(projectPlayerView({ ...r.session.world, players: { ...r.session.world.players, [port.playerId]: { ...r.session.world.players[port.playerId], locale: 'en' } } }, port.playerId), catalog, { detail: 'brief', map: false }), 'en');
    expect(en).toContain('Break: This is a break between expeditions.');
    expect(en).toContain('Note template (item names only; you write the content): next aim / learned (foes, items, terrain) / still unknown / what you gave up on before, and why (does it still hold?)');
    // 迷宮の中の観測には出ない
    expect((await act(port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const o2 = port.observe();
    expect(o2.observation.checkpoint).toBeUndefined();
    expect(o2.text).not.toContain('区切り: ここは遠征の区切り');
    m.closeAll();
  });
});

describe('S7 §52.2 の 2: the checkpoint turn (every 100 own turns, on the first turn with no enemy in view)', () => {
  it('the ledger step: not while enemies are in view, then the first calm turn; once per 100 turns; camp counts as a break', () => {
    const l: CheckpointLedger = { lastCalm: -1, due: [] };
    let seq = 0;
    const turn = (t: number, calm: boolean) => checkpointStep(l, t, calm, ++seq);
    for (let t = 1; t < 100; t++) turn(t, true);
    expect(l.due).toEqual([]);
    // 100 手番目から 104 手番目まで敵が見えていた: 105 手番目に回す
    for (let t = 100; t <= 104; t++) turn(t, false);
    expect(l.due).toEqual([]);
    turn(105, true);
    expect(l.due.map((d) => d.turn)).toEqual([105]);
    // 同じ 100 手番の中では、もう出さない（敵が見えて、また見えなくなっても）
    turn(150, false); turn(151, true);
    expect(l.due.map((d) => d.turn)).toEqual([105]);
    // 200 手番目に敵が見えていなければ、そこで
    for (let t = 152; t <= 200; t++) turn(t, true);
    expect(l.due.map((d) => d.turn)).toEqual([105, 200]);
    // 敵が見えたまま 300 も 400 も越えた: 見えなくなった最初の手番に 1 回だけ
    for (let t = 201; t <= 420; t++) turn(t, t < 299);
    expect(l.due.map((d) => d.turn)).toEqual([105, 200]);
    turn(421, true);
    expect(l.due.map((d) => d.turn)).toEqual([105, 200, 421]);
  });

  it('the live ledger, a fold of the record from the start and a recovered session agree; deferred past enemies in view; the change line appears once per checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s7-cp-'));
    try {
      const m = manager(dir);
      const r = await m.createRun({ name: 'C', seed: 's7-check-2', controller: agent, objective: 'reach_depth' });
      if ('error' in r) throw new Error(r.error.message);
      const pid = r.port.playerId;
      // 控えを最初に作る（ここからは確定のたびに今の World で進む）
      expect(r.session.checkpointTurns(pid)).toEqual([]);
      // 応答の「変化」の行に出た区切りを数える（ボットの応答を横から見る）
      const seen: { turn: number; monsters: number }[] = [];
      const orig = r.port.act.bind(r.port);
      (r.port as { act: PlayerPort['act'] }).act = async (cmd, opts) => {
        const res = await orig(cmd, opts);
        if (res.turn.changes.some((c) => c.code === 'checkpoint')) seen.push({ turn: res.turn.turn_no, monsters: r.port.view().entities.filter((e) => e.cat === 'monster').length });
        return res;
      };
      await playWithPort(r.port, { kind: 'greedy', seed: 's7-check-2', maxActs: 260, maxExpeditions: 3 });
      const live = r.session.checkpointTurns(pid);
      const turns = r.session.world.entities[r.session.world.players[pid].entityId].actor!.turns;
      expect(turns).toBeGreaterThan(200);
      expect(live.length).toBeGreaterThan(0);
      // 区切りは 100 の倍数を越えた後で、100 手番の区切りごとに 1 回まで
      for (const d of live) expect(d.turn).toBeGreaterThanOrEqual(100);
      // このシードでは、100 手番目に敵が見えていて、見えなくなった手番に回った区切りがある
      expect(live.some((d) => d.turn % 100 !== 0)).toBe(true);
      expect(new Set(live.map((d) => Math.trunc(d.turn / 100))).size).toBe(live.length);
      // 記録を初めから畳んだ答えと同じ
      expect(r.session.checkpointTurns(pid, true)).toEqual(live);
      // 応答に出たのは、区切りの手番（敵が見えていなかった手番）を含む応答だけ。同じ区切りを 2 回出さない
      // （マクロの途中の手番が区切りなら、止まった所で敵が見えていることはある: 出す手番は記録から決まり、応答の切れ目にはよらない）
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.length).toBeLessThanOrEqual(live.length);
      for (const s of seen) expect(live.some((d) => d.turn <= s.turn && Math.trunc(d.turn / 100) === Math.trunc(s.turn / 100) || (d.turn <= s.turn && s.turn - d.turn < 100))).toBe(true);
      expect(new Set(seen.map((s) => live.filter((d) => d.turn <= s.turn).length)).size).toBe(seen.length);
      const runId = r.session.runId;
      m.closeAll();
      // 起動し直した後（記録だけから作り直す）も、今の区切りの手番は同じ
      const m2 = manager(dir);
      const rec = RunSession.recover(m2.deps, runId);
      expect(rec.verified).toBe(true);
      const block = Math.trunc(turns / 100);
      const after = rec.session.checkpointTurns(pid);
      // 起動し直した後は、今の 100 手番の区切りが始まる前から畳む: その区切りの分は必ず同じで、ほかに出すものは、もとの控えにあるものだけ
      expect(after).toEqual(live.filter((x) => Math.trunc(x.turn / 100) >= block));
      expect(rec.session.checkpointTurns(pid, true)).toEqual(live);
      m2.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

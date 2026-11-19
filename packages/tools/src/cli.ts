// tools CLI: bot / seed / gen-check / replay-verify / golden / assets-checklist / assets-check
import { loadContent, buildCatalog } from '@muse/content';
import { generateFloor, validateContentHandlers } from '@muse/engine';
import { loadConfig, SessionManager } from '@muse/server';
import { runBot } from './bot';
import type { BotKind } from './bot';
import { assetsCheck, assetsChecklist, slotStatus } from './assets';
import { commandInvoker, drive, dummyInvoker, httpInvoker } from './drive';
import { runPilot } from './pilot';
import { formatPacing, pacingReport } from './pacing';
import { choicesReport, formatChoices } from './choices';
import { buildsReport, formatBuilds } from './builds';
import { budgetReport, formatBudget } from './budget';
import { verifyRunDir, writeGolden } from './replay';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name: string) => argv.includes(`--${name}`);

function stats(xs: number[]) {
  if (!xs.length) return { n: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length), p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
}

const TERRAIN_CH: Record<string, string> = {
  'core:wall': '#', 'core:floor': '.', 'core:door_closed': '+', 'core:door_open': "'", 'core:stairs_down': '>', 'core:stairs_up': '<',
  'core:shallow_water': '~', 'core:grass': ',', 'core:tall_grass': '%', 'core:rubble': '0', 'core:pillar': 'O',
};

async function main() {
  const content = loadContent();
  switch (cmd) {
    case 'bot': {
      const runs = Number(flag('runs', '10'));
      const kind = (flag('kind', 'greedy') as BotKind);
      const seedBase = flag('seed', 'bot');
      const maxActs = Number(flag('max-acts', '2500'));
      const classId = flag('class') ? `core:${flag('class')}` : undefined;
      const config = loadConfig({ runsDir: has('log') ? (flag('runs-dir') ? resolve(flag('runs-dir')!) : loadConfig().runsDir) : null });
      const manager = new SessionManager(content, config);
      const results = [];
      let crashes = 0;
      for (let i = 0; i < runs; i++) {
        try {
          const r = await runBot(manager, { kind, seed: `${seedBase}-${i}`, maxActs, classId, measureObs: has('obs') });
          results.push(r);
          console.log(`#${i} ${r.runId} seed=${r.seed} depth=${r.depth} lv=${r.level} kills=${r.kills} turns=${r.turns} acts=${r.acts} cause=${r.cause ?? '-'} ${r.ms}ms`);
        } catch (e) {
          crashes++;
          console.error(`#${i} CRASH: ${(e as Error).stack}`);
        }
        // メモリ節約: 終わったセッションは閉じる
        for (const [id, s] of manager.sessions) if (s.world.status === 'ended') { s.close(); manager.sessions.delete(id); }
      }
      const depths = results.map((r) => r.depth);
      console.log(`\nruns=${results.length} crashes=${crashes} avgDepth=${(depths.reduce((a, b) => a + b, 0) / Math.max(1, depths.length)).toFixed(2)} maxDepth=${Math.max(0, ...depths)} avgTurns=${stats(results.map((r) => r.turns)).avg}`);
      if (has('obs')) {
        console.log('observation JSON chars brief:', stats(results.flatMap((r) => r.obsBriefChars)));
        console.log('observation JSON chars full :', stats(results.flatMap((r) => r.obsFullChars)));
      }
      if (crashes) process.exitCode = 1;
      break;
    }
    case 'seed': {
      const seed = argv[1] ?? 'demo';
      const from = Number(flag('depth', '1'));
      const to = Number(flag('to', String(from)));
      const table = content.terrain.map((t) => t.id);
      for (let d = from; d <= to; d++) {
        const g = generateFloor(content, seed, 'main', d, table);
        const f = g.floor;
        console.log(`\n== seed=${seed} depth=${d} type=${f.floorType} biome=${f.biome} layout=${g.layout} attempts=${g.attempts} spawns=${g.spawns.length}`);
        for (let y = 0; y < f.height; y++) {
          let row = '';
          for (let x = 0; x < f.width; x++) {
            const sp = g.spawns.find((s) => s.x === x && s.y === y);
            if (sp) row += sp.type === 'monster' ? 'M' : sp.type === 'item' ? '!' : content.features[sp.kind]?.category === 'trap' ? '^' : '&';
            else row += TERRAIN_CH[table[f.terrain[y * f.width + x]]] ?? '?';
          }
          console.log(row);
        }
        console.log('legend: # wall . floor + door > < stairs ~ water , grass % tall grass 0 rubble O pillar M monster ! item & feature ^ trap');
      }
      break;
    }
    case 'gen-check': {
      const seeds = Number(flag('seeds', '100'));
      const depth = Number(flag('depth', '50'));
      const table = content.terrain.map((t) => t.id);
      const t0 = Date.now();
      let worst = 0, fallbacks = 0, total = 0;
      const failures: string[] = [];
      for (let s = 0; s < seeds; s++) {
        for (let d = 1; d <= depth; d++) {
          const t1 = Date.now();
          const g = generateFloor(content, `gen-${s}`, 'main', d, table);
          const dt = Date.now() - t1;
          worst = Math.max(worst, dt);
          total++;
          if (g.layout === 'core:fallback') fallbacks++;
          const errs = checkFloor(g, d, table);
          if (errs.length) failures.push(`seed gen-${s} depth ${d}: ${errs.join(', ')}`);
        }
      }
      console.log(`floors=${total} failures=${failures.length} fallbacks=${fallbacks} total=${Date.now() - t0}ms worst=${worst}ms`);
      for (const f of failures.slice(0, 20)) console.log('  ' + f);
      if (failures.length) process.exitCode = 1;
      break;
    }
    case 'replay-verify': {
      const target = argv[1];
      if (!target) throw new Error('usage: replay-verify <runDir|runId>');
      const dir = target.startsWith('run_') ? resolve(loadConfig().runsDir!, target) : resolve(target);
      const r = verifyRunDir(content, dir);
      console.log(JSON.stringify(r, null, 2));
      if (!r.foldMatchesKeyframe || !r.reexecMatches) process.exitCode = 1;
      break;
    }
    case 'golden': {
      const out = resolve(flag('out', 'packages/tools/test/fixtures/golden')!);
      const r = await writeGolden(content, out, flag('seed', 'golden-1')!);
      console.log(`wrote golden replay to ${out}: ${r.events} events, final hash ${r.hash}`);
      break;
    }
    case 'assets-checklist': {
      const list = assetsChecklist(content, buildCatalog(content));
      if (flag('format') === 'json') console.log(JSON.stringify(list, null, 2));
      else {
        console.log('| class | key | name | required |');
        console.log('|---|---|---|---|');
        for (const a of list) console.log(`| ${a.class} | ${a.key} | ${a.name} | ${slotStatus(a)} |`);
        const supported = list.filter((a) => a.supported);
        console.log(`\n${supported.filter((a) => a.required).length} required / ${supported.length} total（ほかに未対応 ${list.length - supported.length}: fx・ui はレンダラーが図形で描くので作らない。ASSET_SPEC §6.4）`);
      }
      break;
    }
    case 'assets-check': {
      const dir = argv[1] ?? 'packages/client/public/themes/sample';
      const r = assetsCheck(content, resolve(dir));
      for (const l of r.lines) console.log(l);
      if (r.errors) process.exitCode = 1;
      break;
    }
    case 'validate': {
      const errs = validateContentHandlers(content);
      console.log(errs.length ? errs.join('\n') : `content ${content.version} OK`);
      if (errs.length) process.exitCode = 1;
      break;
    }
    case 'pacing': {
      const runs = Number(flag('runs', '40'));
      const manager = new SessionManager(content, loadConfig({ runsDir: null }));
      const results = [];
      for (let i = 0; i < runs; i++) {
        results.push(await runBot(manager, { kind: 'greedy', seed: `${flag('seed', 'pacing')}-${i}`, maxActs: Number(flag('max-acts', '1500')) }));
        for (const [id, s] of manager.sessions) if (s.world.status === 'ended') { s.close(); manager.sessions.delete(id); }
      }
      const rep = pacingReport(results);
      if (has('json')) console.log(JSON.stringify(rep, null, 2));
      else console.log(formatPacing(rep));
      break;
    }
    case 'budget': {
      const manager = new SessionManager(content, loadConfig({ runsDir: null }));
      const rep = await budgetReport(manager, { runs: Number(flag('runs', '30')), maxActs: Number(flag('max-acts', '600')), seed: flag('seed', 'budget')!, ...(flag('slot-runs', '') ? { slotRuns: Number(flag('slot-runs', '')) } : {}), log: has('verbose') ? (s) => console.log(s) : undefined });
      console.log(has('json') ? JSON.stringify(rep, null, 2) : formatBudget(rep));
      break;
    }
    case 'builds': {
      // V3-4 §10: 特技の系統ごとの到達深度と、撃破に占める投擲の割合
      const manager = new SessionManager(content, loadConfig({ runsDir: null }));
      const rep = await buildsReport(manager, { runs: Number(flag('runs', '20')), maxActs: Number(flag('max-acts', '1500')), seed: flag('seed', 'builds')!, log: (s) => console.log(s) });
      console.log('');
      console.log(has('json') ? JSON.stringify(rep, null, 2) : formatBuilds(rep));
      break;
    }
    case 'choices': {
      const manager = new SessionManager(content, loadConfig({ runsDir: null }));
      const rep = await choicesReport(manager, { runs: Number(flag('runs', '40')), maxActs: Number(flag('max-acts', '1500')), seed: flag('seed', 'choices')!, log: (s) => console.log(s) });
      console.log('');
      console.log(has('json') ? JSON.stringify(rep, null, 2) : formatChoices(rep));
      break;
    }
    case 'drive': {
      // 参照ドライバ: npm run drive -- --token <player_token> [--agent dummy|--agent-cmd "<command>"|--agent-url <url>] [--base http://127.0.0.1:7777]
      // プロフィール（V3-7 §16.3）: --new-run <name> --profile-token <tok> で同じプロフィールに積む。--continue でランが終わったら同じプロフィールで次のランを始める（--max-runs 既定 10）
      const base = flag('base', `http://127.0.0.1:${process.env.MUSE_PORT ?? 7777}`)!;
      let token = flag('token');
      let profileToken = flag('profile-token');
      const newRun = async (name: string) => {
        const r = await fetch(new URL('/api/runs', base), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, classId: flag('class') ? `core:${flag('class')}` : undefined, objective: flag('objective'), controller: { kind: 'agent', label: 'drive' }, ...(profileToken ? { profileToken } : {}), ...(has('no-legacy') ? { legacy: false } : {}) }),
        });
        const j = await r.json() as { runId?: string; token?: string; profileId?: string; profileToken?: string; error?: { message: string } };
        if (!j.token) throw new Error(`new run failed: ${j.error?.message ?? r.status}`);
        if (j.profileToken) { profileToken = j.profileToken; console.log(`new profile ${j.profileId} profile_token=${profileToken}（次の drive の --profile-token に渡すと記録が引き継がれる）`); }
        console.log(`new run ${j.runId} player_token=${j.token}`);
        return j.token;
      };
      if (!token && flag('new-run')) token = await newRun(flag('new-run')!);
      if (!token) throw new Error('usage: drive --token <player_token> | --new-run <name> [--profile-token <tok>] [--continue] [--agent dummy | --agent-cmd "<cmd>" | --agent-url <url>]');
      const invoker = flag('agent-cmd') ? commandInvoker(flag('agent-cmd')!) : flag('agent-url') ? httpInvoker(flag('agent-url')!) : dummyInvoker();
      console.log(`driving with ${invoker.name}`);
      const maxRuns = Number(flag('max-runs', '10'));
      for (let run = 1; ; run++) {
        const r = await drive({
          baseUrl: base, token, invoker,
          maxTurns: Number(flag('max-turns', '5000')), maxMs: Number(flag('max-minutes', '360')) * 60000, maxErrors: Number(flag('max-errors', '5')),
          log: (m) => console.log(m),
        });
        console.log(`drive: ${r.outcome} (${r.reason}) after ${r.invocations} agent calls`);
        if (r.text) console.log(r.text);
        if (r.outcome === 'interrupted') console.log('遠征は進行中のまま。もう一度 drive を実行すると続きから進む。');
        // --continue: ランが終わったら、同じプロフィールで次のランを始める
        if (!has('continue') || r.reason !== 'run_ended' || !profileToken || run >= maxRuns) break;
        token = await newRun(flag('new-run') ?? 'Muse');
      }
      break;
    }
    case 'pilot': {
      // 代行 bot の作例（IMPROVEMENTS_V4 §10・packages/tools/src/pilot/README.md）:
      // npm run pilot -- --token <player_token> [--dir <フォルダ>] [--wake-cmd "<コマンド>" | --wake-url <URL>] [--mode solo|coop] [--server <URL>] [--new-run <名前>]
      const base = flag('server', flag('base', `http://127.0.0.1:${process.env.MUSE_PORT ?? 7777}`))!;
      let token = flag('token');
      if (!token && flag('new-run')) {
        const r = await fetch(new URL('/api/runs', base), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: flag('new-run'), classId: flag('class') ? `core:${flag('class')}` : undefined, objective: flag('objective'), ...(flag('mode') === 'coop' ? { mode: 'coop' } : {}), controller: { kind: 'agent', label: 'pilot' }, ...(flag('profile-token') ? { profileToken: flag('profile-token') } : {}) }),
        });
        const j = await r.json() as { runId?: string; token?: string; error?: { message: string } };
        if (!j.token) throw new Error(`new run failed: ${j.error?.message ?? r.status}`);
        console.log(`new run ${j.runId} player_token=${j.token}`);
        token = j.token;
      }
      if (!token) throw new Error('usage: pilot --token <player_token> | --new-run <name> [--dir <folder>] [--wake-cmd "<cmd>" | --wake-url <url>] [--mode solo|coop] [--server <url>]');
      const mode = flag('mode');
      const r = await runPilot({
        baseUrl: base, token, dir: flag('dir'), wakeCmd: flag('wake-cmd'), wakeUrl: flag('wake-url'),
        ...(mode === 'solo' || mode === 'coop' ? { mode } : {}),
        maxActions: Number(flag('max-actions', '5000')), maxMs: Number(flag('max-minutes', '360')) * 60000, maxErrors: Number(flag('max-errors', '5')),
        log: (m) => console.log(m),
      });
      console.log(`pilot: ${r.outcome} (${r.reason}) after ${r.actions} commands; turns pilot ${r.turns.pilot} / queue ${r.turns.queue}; wakes ${JSON.stringify(r.wakes)}`);
      break;
    }
    default:
      console.log('usage: tsx packages/tools/src/cli.ts <bot|seed|gen-check|replay-verify|golden|assets-checklist|assets-check|validate|pacing|choices|budget|drive|pilot> [options]');
  }
}

import type { GeneratedFloor } from '@muse/engine';
import { DIRS, DIR_VEC } from '@muse/shared';

/** 生成不変条件: 階段の相互到達・開始地点の安全・床面積・スポーンが通行可能セル上 */
export function checkFloor(g: GeneratedFloor, depth: number, table: string[]): string[] {
  const content = loadContent();
  const f = g.floor;
  const errs: string[] = [];
  const pass = (i: number) => {
    const t = content.terrain[content.terrainIndex[table[f.terrain[i]]]];
    return t.passable || t.door === 'closed';
  };
  const start = f.entry.y * f.width + f.entry.x;
  if (!pass(start)) errs.push('entry not passable');
  const dist = new Int32Array(f.width * f.height).fill(-1);
  dist[start] = 0;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const cx = c % f.width, cy = (c - cx) / f.width;
    for (const d of DIRS) {
      const nx = cx + DIR_VEC[d][0], ny = cy + DIR_VEC[d][1];
      if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
      const ni = ny * f.width + nx;
      if (dist[ni] >= 0 || !pass(ni)) continue;
      dist[ni] = dist[c] + 1;
      q.push(ni);
    }
  }
  if (!f.stairs.down.length) errs.push('no down stairs');
  for (const s of f.stairs.down) if (dist[s.y * f.width + s.x] < 0) errs.push('down stairs unreachable');
  if (depth > 1 && !f.stairs.up) errs.push('no up stairs');
  if (f.stairs.up && dist[f.stairs.up.y * f.width + f.stairs.up.x] < 0) errs.push('up stairs unreachable');
  for (const sp of g.spawns) {
    if (!pass(sp.y * f.width + sp.x)) errs.push(`spawn ${sp.kind} on impassable cell`);
    if (sp.type === 'monster' && Math.max(Math.abs(sp.x - f.entry.x), Math.abs(sp.y - f.entry.y)) <= 6) errs.push('monster near entry');
  }
  const passable = f.terrain.filter((_, i) => pass(i)).length;
  if (passable * 100 < f.width * f.height * 10) errs.push('floor area too small');
  // 境界は壁
  for (let x = 0; x < f.width; x++) if (pass(x) || pass((f.height - 1) * f.width + x)) { errs.push('open border'); break; }
  return errs;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

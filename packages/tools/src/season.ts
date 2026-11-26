// シーズンの運用（S0。PROTOCOL.md §9.1）: 開く・招く・招きの取り消し・一覧・順位・確定・地下 5 階の大守護者の下見。
// 開く（S9a・S9b）: 確定していないほかのシーズンがあれば、--close-previous が付いているときだけ、先に確定してから開く（付いていなければ、
// 名前と ID を並べて何もせずに 1 で終える。確定は元に戻せない）。記録が読めないシーズンがあれば、何も確定せず・開かない。サーバーは止めてから。
// サーバーと同じ置き場所（既定 runs/seasons。MUSE_SEASONS_DIR か --dir）に書く。動いているサーバーは、知らない ID を聞かれたときに読み直す。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from '@muse/content';
import { createRun, ENGINE_VERSION, previewWarden } from '@muse/engine';
import { normalizeName, ProfileStore, RUNS_LOCK, SeasonService, SeasonStore, SEASON_ID_RE } from '@muse/server';
import type { SeasonDef } from '@muse/server';

export interface SeasonCliArgs {
  sub: string;
  dir: string | null;
  id?: string;
  name?: string;
  seed?: string;
  budget?: number;
  ends?: string;
  seeds?: string[];
  depth?: number;
  /** 名前付きの引数の値にならなかった引数（PowerShell の npm run が --id などを消すと、値だけが残る） */
  stray?: string[];
  /** 招く（S0a）: プロフィールの置き場所（サーバーと同じ。既定 runs/profiles）と、今あるプロフィールを招くときのトークン */
  profilesDir?: string | null;
  profileToken?: string;
  /** 招きの取り消し（S0b）: プロフィールの ID */
  profileId?: string;
  /** open（S9b）: 確定していないほかのシーズンを確定してから開く（付いていなければ、開かずに 1 で終える） */
  closePrevious?: boolean;
  /** open（S9b）: ランの記録の置き場所（サーバーの印 .server.lock を見て、動いていそうなら注意を出す） */
  runsDir?: string | null;
}

/** 記録の置き場所の印（.server.lock）に生きているプロセスがあれば、その説明（S9b。止めはしない。注意を出すだけ） */
function liveServerLock(runsDir: string | null): string | null {
  if (!runsDir) return null;
  const p = join(runsDir, RUNS_LOCK);
  if (!existsSync(p)) return null;
  try {
    const b = JSON.parse(readFileSync(p, 'utf8')) as { pid?: unknown; port?: unknown };
    if (typeof b.pid !== 'number') return null;
    try { process.kill(b.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return null; }
    return `pid ${b.pid}${typeof b.port === 'number' ? `・ポート ${b.port}` : ''}`;
  } catch {
    return null;
  }
}

/** 使われなかった引数の知らせ（PowerShell の `npm run` は名前付きの引数を消し、引用符の無いカンマは別の引数に分ける） */
export function strayArgsHint(stray: readonly string[]): string {
  return `使われなかった引数: ${stray.join(' ')}。PowerShell では \`npm run\` が --id などの名前付きの引数を消すので \`npm.cmd run season -- …\` と書き、カンマを含む値は引用符でくくる（例: --seeds "s0-a,s0-b"） / unused arguments; in PowerShell use npm.cmd and quote values with commas`;
}

export function seasonCli(content: Content, a: SeasonCliArgs, log: (s: string) => void = console.log): number {
  if (a.stray?.length) log(strayArgsHint(a.stray));
  const store = new SeasonStore(a.dir);
  const svc = new SeasonService(store, { engineVersion: ENGINE_VERSION, contentVersion: content.version }, () => null, Date.now, content.balance.season.supportMinHealPct, content.lists.seasonTitles);
  switch (a.sub) {
    case 'open': {
      if (!a.id || !SEASON_ID_RE.test(a.id)) { log('--id が要る（英小文字・数字・_・-、32 文字まで）'); return 1; }
      if (!a.seed) { log('--seed が要る（シーズンのシード。参加者には知らせない）'); return 1; }
      const endsAt = a.ends ? Date.parse(a.ends) : NaN;
      if (!Number.isFinite(endsAt)) { log('--ends が要る（ISO 8601 の時刻。例 2026-12-01T21:00:00+09:00）'); return 1; }
      if (endsAt <= Date.now()) { log(`--ends が過去の時刻: ${a.ends}`); return 1; }
      // 名前は、名前を整える 1 つの関数で（S12c。拠点の口と同じ。32 字を超えたら、切らずに断る）
      const nm = normalizeName(a.name ?? a.id);
      if (!nm.ok) { log(`--name: ${nm.message}`); return 1; }
      const def: SeasonDef = {
        id: a.id, name: nm.name, seed: a.seed, engineVersion: ENGINE_VERSION, contentVersion: content.version,
        budget: a.budget ?? 3000, endsAt, openedAt: Date.now(),
      };
      // 開いてよいかは、拠点の運用者の口と同じ関数で見る（S12b。SeasonService.openBlockers）
      const blk = svc.openBlockers(def.id);
      // 同じ ID がもうあれば、前のシーズンを確定する前に断る（開けないのに閉じてしまわない）
      if (blk.exists) { log(`season ${def.id} already exists`); return 1; }
      // 記録が読めないシーズンがあれば、何も確定せず・開かない（S9b。どのシーズンの、どのファイルかを出す）
      const broken = blk.broken;
      if (broken.length) {
        for (const b of broken) log(`シーズン ${b.id} の記録が読めない: ${b.files.join('・')}`);
        log('記録が読めないシーズンがあるので、新しいシーズンを開かない（何も確定していない）。直してから、もう一度 open する');
        return 1;
      }
      // シーズンの期間は重ならない（S9a。SEASON.md §57.2・§57.3 の 4）: 確定していないシーズンがほかにあれば、先に確定する（close と同じ処理）。
      // 確定は元に戻せないので、--close-previous が付いているときだけ（S9b。付いていなければ、名前と ID を並べて、何もせずに終える）
      const unresolved = blk.unresolved;
      if (unresolved.length && !a.closePrevious) {
        for (const d of unresolved) log(`開催中のシーズン ${d.def.id}「${d.def.name}」がある。新しいシーズンを開くと、それを確定する（元に戻せない）。よければ --close-previous を付ける`);
        log('（何もしていない。PowerShell では `npm.cmd run season -- open … --close-previous` と書く。`npm run` は名前付きの引数を消す）');
        return 1;
      }
      if (unresolved.length) {
        const busy = liveServerLock(a.runsDir ?? null);
        if (busy) log(`注意: 記録の置き場所の印（.server.lock）に、生きているプロセス（${busy}）がある。サーバーが動いているなら、止めてから開く（保存待ちの手番を取りこぼさないため。SEASON.md §22）`);
        log('（新しいシーズンを開く前に、確定していないシーズンを確定する）');
      }
      for (const d of unresolved) {
        const r = svc.finalize(d, 'operator');
        log(`前のシーズン ${d.def.id}「${d.def.name}」を確定した（このシーズンのランは、もう命令を受けない。記録は見返せる）。冒険 ${r.winners.adventure.map((w) => w.name).join('・') || '-'}／貢献 ${r.winners.contribution.map((w) => w.name).join('・') || '-'}／生還 ${r.winners.survival.map((w) => w.name).join('・') || '-'}／支援 ${(r.winners.support ?? []).map((w) => w.name).join('・') || '-'}`);
        log(r.titles?.length ? `  称号: ${r.titles.map((x) => `${x.holder}「${x.name.ja}」`).join('・')}` : '  称号: なし');
      }
      try { svc.open(def); } catch (e) { log((e as Error).message); return 1; }
      log(`シーズン ${def.id}「${def.name}」を開いた: 予算 ${def.budget} 手番・終わり ${new Date(def.endsAt).toISOString()}・engine ${def.engineVersion}・content ${def.contentVersion}${a.dir ? `（${a.dir}）` : ''}`);
      return 0;
    }
    case 'invite': {
      // 招く（S0a。SEASON.md §4.1）: 招かれたプロフィールだけが、そのシーズンのランを始められる
      if (!a.id) { log('--id が要る（シーズンの ID）'); return 1; }
      if (!a.name && !a.profileToken) { log('--name が要る（表示名。同じシーズンの中で重ならないこと）'); return 1; }
      const r = svc.invite(a.id, a.name ?? '', new ProfileStore(a.profilesDir ?? null), a.profileToken);
      if ('error' in r) { log(r.error); return 1; }
      log(`シーズン ${a.id} に「${r.name}」を招いた（profile_id: ${r.profileId}）。`);
      if (r.token) {
        log(`profile_token: ${r.token}`);
        log(`このトークンは、この 1 回だけ表示する。参加者へ手で渡す（リポジトリ・記録・チャットの公開の場には残さない）。参加は new_run { character_name, season: "${a.id}", profile_token }。`);
      } else log('今あるプロフィールを招いた。参加者は、今のトークンのまま new_run { season } で参加できる。');
      return 0;
    }
    case 'uninvite': {
      // 招きの取り消し（S0b。SEASON.md §6.2 の 5）: ランを 1 回も始めていない者だけ
      if (!a.id) { log('--id が要る（シーズンの ID）'); return 1; }
      const r = svc.uninvite(a.id, { ...(a.name ? { name: a.name } : {}), ...(a.profileId ? { profileId: a.profileId } : {}) });
      if ('error' in r) { log(r.error); return 1; }
      log(`シーズン ${a.id} の「${r.name}」（${r.profileId}）の招きを取り消した。このプロフィールは、もうこのシーズンのランを始められない（プロフィールそのものは残る。同じプロフィールを招き直すなら invite --profile-token <そのトークン>）。表示名「${r.name}」は、また使える。`);
      return 0;
    }
    case 'invites': {
      if (!a.id || !svc.get(a.id)) { log(`シーズン ${a.id ?? '(--id)'} は無い`); return 1; }
      const list = store.invites(a.id);
      const ps = svc.get(a.id)!.participants;
      if (!list.length) log('まだだれも招いていない');
      for (const x of list) log(`${x.name}（${x.profileId}）招いた ${new Date(x.invitedAt).toISOString()}・ラン ${ps.find((p) => p.profileId === x.profileId)?.runs.length ?? 0}`);
      return 0;
    }
    case 'list': {
      const list = svc.list();
      const broken = svc.brokenSeasons();
      if (!list.length && !broken.length) log('シーズンは無い');
      // 記録が読めないシーズン（SEASON.md §33.1 の 4）: 読まず、書き戻さない。どのファイルかを出す
      for (const b of broken) log(`${b.id} 記録が読めない: ${b.files.join('・')}（直すまで、このシーズンは読まない・書かない）`);
      for (const s of list) log(`${s.id}「${s.name}」 ${s.status} 予算 ${s.budget} 終わり ${new Date(s.endsAt).toISOString()} 招いた ${s.invited}・始めた ${s.participants}`);
      return 0;
    }
    case 'standings': {
      // 運用の道具（運用者）は、開催中でも討伐の記録の中身まで読める（S4a §46）
      const st = a.id ? svc.standings(a.id, { full: true }) : null;
      if (!st) { log(`シーズン ${a.id ?? '(--id)'} は無い`); return 1; }
      log(`${st.season.id}「${st.season.name}」 ${st.season.status}${st.result ? `（確定 ${new Date(st.result.finalizedAt).toISOString()}・${st.result.reason}）` : ''}`);
      log('| 名前 | ラン | 使った予算 | 冒険（最深） | 貢献（最初の報告） | 生還（確定点） | 支援（火が使われた・預けた品が取られた） |');
      log('|---|---|---|---|---|---|---|');
      for (const r of st.standings) {
        log(`| ${r.name}${r.died ? '（倒れた）' : ''}${r.titles?.length ? `［${r.titles.map((x) => x.name.ja).join('・')}］` : ''} | ${r.runs} | ${r.used} | ${r.adventure.rank}位 地下${r.adventure.value}階 | ${r.contribution.rank}位 ${r.contribution.value} | ${r.survival ? `${r.survival.rank}位 ${r.survival.value}` : '対象外'} | ${r.support ? `${r.support.rank}位 ${r.support.value}` : '-'} |`);
      }
      // 補給の置き場（S3 §25.2）: 共有層に載った品（階・置き場・種類・預けた者・取った者・二重に取られたか）。運用者向け（種類も出す）
      const sup = svc.get(a.id!)?.supplies ?? [];
      if (sup.length) {
        const nameOf = (pid: string) => svc.get(a.id!)?.participants.find((p) => p.profileId === pid)?.name ?? pid;
        const place = (p: string) => (p === 'stairs_up' ? '上り階段' : p === 'stairs_down' ? '下り階段' : '野営の火');
        const waiting = sup.filter((x) => !x.takenBy).length;
        const doubles = sup.filter((x) => x.doubles?.length).length;
        log(`補給の置き場: 載った品 ${sup.length}（置き場にある ${waiting}・取られた ${sup.length - waiting}・二重に取られた ${doubles}）`);
        for (const x of [...sup].sort((p, q) => p.depth - q.depth || p.order - q.order)) {
          log(`  ${x.id} 地下${x.depth}階 ${place(x.place)} (${x.x},${x.y}) ${x.kind}${x.identified ? '' : '（未鑑定で預けた）'} 預けた ${x.by}${x.takenBy ? `・取った ${nameOf(x.takenBy)}${x.takenBy === x.profileId ? '（本人）' : ''}` : ''}${x.doubles?.length ? `・二重 ${x.doubles.map(nameOf).join('・')}` : ''}`);
        }
      }
      return 0;
    }
    case 'close': {
      const d = a.id ? svc.get(a.id) : null;
      if (!d) { log(`シーズン ${a.id ?? '(--id)'} は無い`); return 1; }
      if (d.result) { log(`シーズン ${d.def.id} はもう確定している`); return 0; }
      const r = svc.finalize(d, 'operator');
      log('（シーズンを手で閉じるときは、サーバーを止めてから close する。動いているサーバーに任せるなら、終わりの時刻を待つ。保存待ちの手番を取りこぼさないため。SEASON.md §22）');
      log(`シーズン ${d.def.id} を確定した。冒険 ${r.winners.adventure.map((w) => w.name).join('・') || '-'}／貢献 ${r.winners.contribution.map((w) => w.name).join('・') || '-'}／生還 ${r.winners.survival.map((w) => w.name).join('・') || '-'}／支援 ${(r.winners.support ?? []).map((w) => w.name).join('・') || '-'}`);
      // 称号（S2 §18.2）: ランを始めた参加者が 2 人に満たなければ付かない
      log(r.titles?.length ? `称号: ${r.titles.map((x) => `${x.holder}「${x.name.ja}」`).join('・')}` : '称号: なし（ランを始めた参加者が 2 人に満たない・1 位の値が 0・初討伐が無い）');
      return 0;
    }
    case 'wardens': {
      // シード選び（SEASON.md §2.8）: シードごとの節目の大守護者の種族と装甲の目安
      const depth = a.depth ?? 5;
      const seeds = a.seeds ?? [];
      if (!seeds.length) { log('--seeds "a,b,c" が要る（カンマで区切ったシード。PowerShell では引用符でくくる）'); return 1; }
      log(`| シード | 地下${depth}階の大守護者 | 体力 | 装甲の目安 | 最大の一撃 | 弱点 |`);
      log('|---|---|---|---|---|---|');
      for (const seed of seeds) {
        const { world } = createRun(content, { runId: 'run_preview', seed });
        const w = previewWarden(world, content, depth);
        log(w ? `| ${seed} | ${w.kind}${w.affixes.length ? `（${w.affixes.join('・')}）` : ''} | ${w.hp} | ${w.armor} | ${w.maxHit} | ${w.weakness ?? '-'} |` : `| ${seed} | （その深さは節目の階でない） | | | | |`);
      }
      return 0;
    }
    default:
      log('使い方（PowerShell）: npm.cmd run season -- open --id <id> --seed <seed> --ends "<ISO 時刻>" [--name <名前>] [--budget 3000] [--close-previous]（確定していないほかのシーズンがあれば、--close-previous で先に確定する。元に戻せない。サーバーを止めてから） / invite --id <id> --name <表示名> [--profile-token <今あるトークン>] / uninvite --id <id> (--name <表示名> | --profile <profile_id>) / invites --id <id> / list / standings --id <id> / close --id <id>（サーバーを止めてから） / wardens --seeds "a,b,c" [--depth 5]  （共通: --dir <置き場所>・--profiles-dir <プロフィールの置き場所>。bash では npm run）');
      return 1;
  }
}

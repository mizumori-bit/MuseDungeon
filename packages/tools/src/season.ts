// シーズンの運用（S0。PROTOCOL.md §9.1）: 開く・招く・招きの取り消し・一覧・順位・確定・地下 5 階の大守護者の下見。
// サーバーと同じ置き場所（既定 runs/seasons。MUSE_SEASONS_DIR か --dir）に書く。動いているサーバーは、知らない ID を聞かれたときに読み直す。
import type { Content } from '@muse/content';
import { createRun, ENGINE_VERSION, previewWarden } from '@muse/engine';
import { ProfileStore, SeasonService, SeasonStore, SEASON_ID_RE } from '@muse/server';
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
}

/** 使われなかった引数の知らせ（PowerShell の `npm run` は名前付きの引数を消し、引用符の無いカンマは別の引数に分ける） */
export function strayArgsHint(stray: readonly string[]): string {
  return `使われなかった引数: ${stray.join(' ')}。PowerShell では \`npm run\` が --id などの名前付きの引数を消すので \`npm.cmd run season -- …\` と書き、カンマを含む値は引用符でくくる（例: --seeds "s0-a,s0-b"） / unused arguments; in PowerShell use npm.cmd and quote values with commas`;
}

export function seasonCli(content: Content, a: SeasonCliArgs, log: (s: string) => void = console.log): number {
  if (a.stray?.length) log(strayArgsHint(a.stray));
  const store = new SeasonStore(a.dir);
  const svc = new SeasonService(store, { engineVersion: ENGINE_VERSION, contentVersion: content.version });
  switch (a.sub) {
    case 'open': {
      if (!a.id || !SEASON_ID_RE.test(a.id)) { log('--id が要る（英小文字・数字・_・-、32 文字まで）'); return 1; }
      if (!a.seed) { log('--seed が要る（シーズンのシード。参加者には知らせない）'); return 1; }
      const endsAt = a.ends ? Date.parse(a.ends) : NaN;
      if (!Number.isFinite(endsAt)) { log('--ends が要る（ISO 8601 の時刻。例 2026-12-01T21:00:00+09:00）'); return 1; }
      if (endsAt <= Date.now()) { log(`--ends が過去の時刻: ${a.ends}`); return 1; }
      const def: SeasonDef = {
        id: a.id, name: (a.name ?? a.id).slice(0, 32), seed: a.seed, engineVersion: ENGINE_VERSION, contentVersion: content.version,
        budget: a.budget ?? 3000, endsAt, openedAt: Date.now(),
      };
      try { store.open(def); } catch (e) { log((e as Error).message); return 1; }
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
      if (!list.length) log('シーズンは無い');
      for (const s of list) log(`${s.id}「${s.name}」 ${s.status} 予算 ${s.budget} 終わり ${new Date(s.endsAt).toISOString()} 招いた ${s.invited}・始めた ${s.participants}`);
      return 0;
    }
    case 'standings': {
      const st = a.id ? svc.standings(a.id) : null;
      if (!st) { log(`シーズン ${a.id ?? '(--id)'} は無い`); return 1; }
      log(`${st.season.id}「${st.season.name}」 ${st.season.status}${st.result ? `（確定 ${new Date(st.result.finalizedAt).toISOString()}・${st.result.reason}）` : ''}`);
      log('| 名前 | ラン | 使った予算 | 冒険（最深） | 貢献（最初の報告） | 生還（確定点） | 支援（火が使われた回数） |');
      log('|---|---|---|---|---|---|---|');
      for (const r of st.standings) {
        log(`| ${r.name}${r.died ? '（倒れた）' : ''} | ${r.runs} | ${r.used} | ${r.adventure.rank}位 地下${r.adventure.value}階 | ${r.contribution.rank}位 ${r.contribution.value} | ${r.survival ? `${r.survival.rank}位 ${r.survival.value}` : '対象外'} | ${r.support ? `${r.support.rank}位 ${r.support.value}` : '-'} |`);
      }
      return 0;
    }
    case 'close': {
      const d = a.id ? svc.get(a.id) : null;
      if (!d) { log(`シーズン ${a.id ?? '(--id)'} は無い`); return 1; }
      if (d.result) { log(`シーズン ${d.def.id} はもう確定している`); return 0; }
      const r = svc.finalize(d, 'operator');
      log(`シーズン ${d.def.id} を確定した。冒険 ${r.winners.adventure.map((w) => w.name).join('・') || '-'}／貢献 ${r.winners.contribution.map((w) => w.name).join('・') || '-'}／生還 ${r.winners.survival.map((w) => w.name).join('・') || '-'}／支援 ${(r.winners.support ?? []).map((w) => w.name).join('・') || '-'}`);
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
      log('使い方（PowerShell）: npm.cmd run season -- open --id <id> --seed <seed> --ends "<ISO 時刻>" [--name <名前>] [--budget 3000] / invite --id <id> --name <表示名> [--profile-token <今あるトークン>] / uninvite --id <id> (--name <表示名> | --profile <profile_id>) / invites --id <id> / list / standings --id <id> / close --id <id> / wardens --seeds "a,b,c" [--depth 5]  （共通: --dir <置き場所>・--profiles-dir <プロフィールの置き場所>。bash では npm run）');
      return 1;
  }
}

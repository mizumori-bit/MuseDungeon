// シーズン（S2。SEASON.md §18.1）の表示部品: 迷宮の中の予算・この階の公開と火・火の命令、キャンプの賞の表・報告・自分の火。
// 文と数値は観測（buildObservation。projectPlayerView を通った PlayerView から作る）のものを並べるだけで、ゲームの判定はしない。
// 命令は AI と同じもの（place_fire・interact・extract・report_stairs）を送る。
import type { Dir, ObsSeason, Observation, PlayerView } from '@muse/shared';
import { tr } from '../util';

const DIRS: readonly [Dir, number, number][] = [['n', 0, -1], ['ne', 1, -1], ['e', 1, 0], ['se', 1, 1], ['s', 0, 1], ['sw', -1, 1], ['w', -1, 0], ['nw', -1, -1]];

/** valid_actions の行の括弧の中（「place_fire (…)」の …） */
export function actionInner(line: string): string {
  const i = line.indexOf(' (');
  return i >= 0 && line.endsWith(')') ? line.slice(i + 2, -1) : line;
}
const unavailable = (inner: string) => inner.startsWith('不可') || inner.startsWith('unavailable');

/** 火を置く（place_fire）の行と、置けるか（観測が engine と同じ順で決めた見込み。最後に決めるのは engine） */
export function placeFireOf(obs: Observation | null): { line: string; inner: string; ok: boolean } | null {
  const line = obs?.valid_actions.find((l) => l.startsWith('place_fire'));
  if (!line) return null;
  const inner = actionInner(line);
  return { line, inner, ok: !unavailable(inner) };
}

/** 火で回復（足元か隣の野営の火）。dir: 足元なら null。text: valid_actions の interact の行（戻る HP か、使えない理由） */
export interface FireHeal { dir: Dir | null; text: string; ok: boolean; by: string }

export function fireHealsOf(view: PlayerView | null, obs: Observation | null): FireHeal[] {
  const me = view?.self.pos;
  if (!me || !obs) return [];
  const out: FireHeal[] = [];
  for (const ft of obs.visible.features) {
    if (!ft.by) continue;
    const dx = ft.pos.x - me.x, dy = ft.pos.y - me.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 1) continue;
    const dir = dx === 0 && dy === 0 ? null : DIRS.find(([, x, y]) => x === dx && y === dy)?.[0] ?? null;
    const head = `interact${dir ? ` ${dir}` : ''} (`;
    const lines = obs.valid_actions.filter((l) => l.startsWith(head));
    // 同じマスにその世界の地物があると interact の行が 2 つになる。火の行は、火の名前か、火の使えない理由のもの
    const line = lines.find((l) => l.includes(ft.name)) ?? lines.find((l) => unavailable(actionInner(l)));
    if (!line) continue;
    const text = actionInner(line);
    out.push({ dir, text, ok: !unavailable(text), by: ft.by });
  }
  return out;
}

/** 帰り支度の残り（状態 core:fire_return。S1c §14.3） */
export function fireReturnLeft(view: PlayerView | null): number | null {
  const st = view?.self.statuses.find((s) => s.id === 'core:fire_return');
  return st ? st.turnsLeft : null;
}

/**
 * 迷宮の中のシーズンの枠: 予算の 1 行・この階の公開された階段と特別な場所・野営の火・この遠征で火を使った階・支援賞の行・
 * 火から帰れるか・帰り支度の残り、と命令（火を置く・火で回復）
 */
export function SeasonDungeonPanel({ view, obs, onPlaceFire, onFireHeal }: {
  view: PlayerView; obs: Observation; onPlaceFire: () => void; onFireHeal: (dir: Dir | null) => void;
}) {
  const s = obs.season;
  if (!s || !view.floor) return null;
  const depth = view.floor.depth;
  const pub = view.season?.public.find((p) => p.depth === depth);
  const fires = obs.visible.features.filter((f) => f.by);
  const spots = obs.visible.features.filter((f) => f.public_by);
  const pf = placeFireOf(obs);
  const heals = fireHealsOf(view, obs);
  const via = obs.expedition?.extract_via;
  const packing = fireReturnLeft(view);
  return (
    <section class="panel season">
      <h3>{tr(`シーズン「${s.name}」`, `Season "${s.name}"`)}</h3>
      <div class="sbudget">{s.text}</div>
      <ul class="sfloor">
        <li>{pub
          ? tr(`この階の下り階段は公開されている（${pub.by} が報告）。入口からの道しるべは、紫の斜線のマス（travel_to stairs_down・T で向かえる）`, `This floor's down stairs are published (reported by ${pub.by}); the trail from the entrance is the hatched purple cells (T / travel_to stairs_down goes there)`)
          : tr('この階の下り階段は、まだ公開されていない', 'This floor\'s down stairs are not published yet')}</li>
        {spots.map((f) => <li key={f.id}>{tr(`${f.name} (${f.pos.x},${f.pos.y})（公開: ${f.public_by} が報告）`, `${f.name} (${f.pos.x},${f.pos.y}) (published by ${f.public_by})`)}</li>)}
        {fires.map((f) => <li key={f.id} class="sfire">{`${f.name} (${f.pos.x},${f.pos.y})`}</li>)}
        {s.fire_used && <li class="muted">{s.fire_used.text}</li>}
        {s.support && <li class="muted">{s.support.text}</li>}
      </ul>
      {packing !== null && <div class="spacking">{tr(`帰り支度の残り ${packing} 手番（追ってくる敵が見えたり、被害を受けたりしたら取りやめ）`, `Packing up: ${packing} turns left (cancelled if a hunter comes into view or you are hurt)`)}</div>}
      {via && packing === null && (
        <div class="svia">{tr(`ここから帰れる: ${via.by} の野営の火（帰り支度 ${via.turns} 手番・この手番を含む）。帰還/撤退（E）`, `You can return from here: ${via.by}'s campfire (${via.turns} turns packing up, this one included). Extract (E)`)}</div>
      )}
      <div class="row wrap">
        {heals.map((h) => (
          <button key={h.dir ?? 'here'} class={`small fireheal ${h.ok ? '' : 'off'}`} disabled={!h.ok} title={h.text} onClick={() => onFireHeal(h.dir)}>
            {tr('火で回復', 'Heal at fire')}{h.dir ? ` ${h.dir}` : ''}: {h.text}
          </button>
        ))}
        {pf && (
          <button class={`small placefire ${pf.ok ? '' : 'off'}`} title={pf.inner} onClick={onPlaceFire}>
            {pf.ok ? tr('火を置く…', 'Set a campfire…') : tr('火を置く（不可）', 'Set a campfire (unavailable)')}
          </button>
        )}
      </div>
      {pf && !pf.ok && <div class="muted small">{pf.inner}</div>}
    </section>
  );
}

/** 火を置く前の確かめの文（費用・確定点・シーズンの残りの数は観測の行のまま） */
export function placeFireConfirmText(inner: string): string {
  return tr(`ここに野営の火を置きますか？（1 手番。払った点は戻らない。置いた火は動かせない・消せない）\n\n${inner}`, `Set a campfire here? (1 turn. The cost is not refunded; the fire cannot be moved or removed.)\n\n${inner}`);
}

/** キャンプのシーズンの枠: 予算・4 つの賞の順位（自分の値と順位・1 位の名前と値・差）・報告していない階段と特別な場所と「報告する」・自分の火・知らせ */
export function SeasonCampPanel({ season: s, canReport, onReport }: { season: ObsSeason; canReport: boolean; onReport: () => void }) {
  const st = s.stairs;
  const sp = s.spots;
  return (
    <div class="seasoncamp">
      <h3>{tr(`シーズン「${s.name}」`, `Season "${s.name}"`)}</h3>
      <div class="sbudget">{s.text}{s.ended ? tr('（終わりの時刻を過ぎた: 新しい遠征は始められない）', ' (past its end: no new expeditions)') : ''}</div>
      {(s.fire_news ?? []).map((n, i) => <div key={i} class="snews">{n.text}</div>)}
      {s.awards && (
        <table class="awards">
          <tbody>
            {s.awards.map((a) => (
              <tr key={a.id} class={a.rank === 1 ? 'lead' : ''}>
                <td>{a.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div class="sreport">
        <span>{tr(`まだ報告していない階段 ${st?.unreported ?? 0}（うち、まだだれも公開していないもの ${st?.unpublished ?? 0}）`, `Unreported stairs ${st?.unreported ?? 0} (not published by anyone yet: ${st?.unpublished ?? 0})`)}</span>
        {sp && sp.unreported > 0 && <span>{tr(`・特別な場所 ${sp.unreported}（うち未公開 ${sp.unpublished}）`, `, special places ${sp.unreported} (unpublished ${sp.unpublished})`)}</span>}
        <button class="small primary" disabled={!canReport} onClick={onReport}
          title={tr('このランで自分の目で見た下り階段と特別な場所を、まとめて報告する（手番を使わない）。最初に報告した者に貢献 1', 'Report the down stairs and special places you saw this run (uses no turn). The first reporter gets 1 contribution')}>
          {tr('報告する', 'Report')}
        </button>
      </div>
      {s.fires_text && <div class="sfires">{s.fires_text}</div>}
    </div>
  );
}

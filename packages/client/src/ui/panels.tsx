// 情報パネル（Preact）。表示名は公開カタログ、状態は PlayerView / World から。
import type { AgentActivity, Alert, Catalog, CommandRecord, ObsMonster, Observation, PlayerView, RunSummary, World } from '@muse/shared';
import {
  abilityStatus, accBonuses, curseUnknown, dealtText, dirLabel, endReasonText, floorTraitsText, hitsText, hpEstimateText, hpState, isCursedItem, itemDisplayName, itemStats, itemStatsText, kindName, nameOf,
  objectiveText, sameOrWorseEquip, shortId, xpForLevel,
} from '@muse/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PLAYER_COLORS } from '../render/scene';
import { getLocale, tr } from '../util';
import {
  abilityStateLabel, buildRowLabels, curseLabel, cursedRemoveText, DIR_ARROW, exploredLabel, lifelineEffectText, monsterLooksText, monsterSpeedLabel, playerStateLabel, reachAttackTitle,
  threatText, worstTurnText,
} from './labels';

/** 手放せない品（帰還の綱）か。捨てる・投げることができず、所持数に数えない（V3-2R2 §18.1） */
export function isBoundItem(catalog: Catalog | null | undefined, kind: string | null): boolean {
  return !!kind && !!catalog?.items[kind]?.bound;
}

/** 所持数（手放せない品を数えない。観測の self.inventory_count と同じ数え方） */
export function carriedCount(view: PlayerView, catalog: Catalog | null | undefined): number {
  return view.inventory.filter((it) => !isBoundItem(catalog, it.kind)).length;
}

function HpBar({ hp, max }: { hp: number; max: number }) {
  const frac = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  const color = frac > 0.6 ? '#4caf50' : frac > 0.35 ? '#ffc107' : frac > 0.2 ? '#ff7043' : '#e53935';
  return (
    <div class="hpbar"><div style={{ width: `${frac * 100}%`, background: color }} /><span>{hp}/{max}</span></div>
  );
}

/**
 * speed: 実効の速さ（観測の self.speed。状態異常込み）。無ければ基本の速さ。
 * floor: 観測の self.floor（下への風・探索の進み具合。V3-2R2 §18.4）
 */
export function StatusPanel({ view, catalog, speed, floor }: { view: PlayerView; catalog: Catalog; speed?: number; floor?: Observation['self']['floor'] }) {
  const L = getLocale();
  const s = view.self;
  const f = view.floor;
  const sp = speed ?? s.speed;
  const rec = view.record;
  const explored = floor?.explored;
  const draft = floor?.draft;
  // ビルド（V3-4）: 取った特技（段階の数）・能動技の状態・習熟と装備による命中の修正
  const rows = buildRowLabels();
  const ranks = new Map<string, number>();
  for (const id of s.build.perks) ranks.set(id, (ranks.get(id) ?? 0) + 1);
  const bonus = accBonuses(view, catalog);
  const sgn = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  return (
    <section class="panel">
      <h3>{s.name} <small>{kindName(catalog, L, s.classId)} Lv{s.level}</small></h3>
      <HpBar hp={s.stats.hp} max={s.stats.maxHp} />
      <div class="kv">
        <span>{tr('確定点', 'Banked')}</span>
        <span class="banked">
          <b>{rec.banked}</b> <small class="muted">{tr(`遠征達成 ${rec.expeditions}`, `${rec.expeditions} completed`)}{rec.lost ? tr(`・失った戦利品 ${rec.lost}`, `, lost ${rec.lost}`) : ''}</small>
        </span>
        <span>XP</span><span>{s.xp} / {xpForLevel(s.level)}</span>
        <span>{tr('階層', 'Depth')}</span><span>{f ? `${tr('地下', 'B')}${f.depth}${tr('階', 'F')} ${nameOf(catalog.biomes[f.biome]?.name, L, f.biome)}` : '-'}</span>
        {(explored || draft || !!f?.traits?.length) && (
          <>
            <span>{tr('この階', 'This floor')}</span>
            <span class="floorhint">
              {f?.traits?.length ? <span title={tr('この階を作ったときに効いた遠征の条件（作られた階に残る）', 'Expedition traits in effect when this floor was made (they stay with the floor)')}>{floorTraitsText(L, catalog.rules, f.traits)}</span> : null}
              {explored && <span title={tr('この階の通れるマスのうち、見た割合（4 段階）', 'Share of this floor\'s walkable cells you have seen (4 bands)')}>{tr(`探索 ${exploredLabel(explored)}`, `explored ${exploredLabel(explored)}`)}</span>}
              {draft && (
                <span class="draft" title={tr('この階の下り階段の方角（まだ見ていないときだけ。遠近は分からない）。地図では自分の横に水色の矢印', 'Direction of this floor\'s down stairs (only until you see them; distance unknown). Shown as a cyan arrow next to you on the map')}>
                  <b class="darrow">{DIR_ARROW[draft]}</b>{tr(`下への風: ${dirLabel(L, draft)}`, `draft: ${dirLabel(L, draft)}`)}
                </span>
              )}
            </span>
          </>
        )}
        <span>{tr('命中/ダメージ', 'Acc/Dmg')}</span><span>+{s.stats.acc} / {s.stats.dmg}{s.stats.might ? (s.stats.might > 0 ? `+${s.stats.might}` : s.stats.might) : ''}</span>
        <span>{tr('回避/装甲', 'Eva/Armor')}</span><span>{s.stats.eva} / {s.stats.armor}</span>
        <span>{tr('速さ', 'Speed')}</span><span>{sp}{sp !== 100 ? <small class="muted"> {tr('（標準 100）', '(normal 100)')}</small> : null}</span>
        <span>{tr('状態', 'Status')}</span>
        <span>{s.statuses.length ? s.statuses.map((x) => `${nameOf(catalog.statuses[x.id]?.name, L, x.id)}(${x.turnsLeft})`).join(' ') : tr('なし', 'none')}</span>
        {(s.boons ?? []).length > 0 && (
          <>
            <span>{tr('加護', 'Boons')}</span>
            <span class="boons">
              {s.boons.map((id) => {
                const b = catalog.boons?.[id];
                const used = !!view.expedition && view.expedition.status !== 'ended' && s.boonUsed?.[id] === view.expedition.no;
                return <span key={id} class={used ? 'boon used' : 'boon'} title={nameOf(b?.desc, L, '')}>{nameOf(b?.name, L, id)}{used ? tr('（使用済み）', ' (used)') : ''}</span>;
              })}
            </span>
          </>
        )}
        {(bonus.melee !== 0 || bonus.thrown !== 0) && (
          <>
            <span>{rows.bonus}</span>
            <span title={rows.bonusTitle}>{tr(`近接 ${sgn(bonus.melee)}・投擲 ${sgn(bonus.thrown)}`, `melee ${sgn(bonus.melee)}, thrown ${sgn(bonus.thrown)}`)}</span>
          </>
        )}
        {ranks.size > 0 && (
          <>
            <span>{rows.perks}</span>
            <span class="perklist">
              {[...ranks].map(([id, n]) => (
                <span key={id} class="perk" title={nameOf(catalog.perks[id]?.desc, L, '')}>{nameOf(catalog.perks[id]?.name, L, shortId(id))}{n > 1 ? `×${n}` : ''}</span>
              ))}
            </span>
          </>
        )}
        {s.build.abilities.length > 0 && (
          <>
            <span>{rows.abilities}</span>
            <span class="perklist">
              {s.build.abilities.map((a) => {
                const st = abilityStatus(view, catalog, a.id);
                const def = catalog.abilities[a.id];
                const ready = st.cooldownLeft <= 0 && st.usesLeft !== 0;
                return (
                  <span key={a.id} class={`abil ${ready ? 'ready' : 'cooling'}`} title={nameOf(def?.desc, L, '')}>
                    {nameOf(def?.name, L, shortId(a.id))} <small>{abilityStateLabel({ cooldown_left: st.cooldownLeft, uses_left: st.usesLeft ?? undefined })}</small>
                  </span>
                );
              })}
            </span>
          </>
        )}
        <span>{tr('時刻', 'Time')}</span><span>{f?.time ?? 0}</span>
      </div>
    </section>
  );
}

export type InvAction = 'use' | 'equip' | 'unequip' | 'drop' | 'throw';

/**
 * exposed: 隣に起きている追跡中の敵がいる（薬・巻物を使う間にその敵が行動する。V3-2R3 §20.4）。使うボタンに印を付ける
 */
export function InventoryPanel({ view, catalog, onAction, focused, selected, onSelect, exposed }: {
  view: PlayerView; catalog: Catalog; onAction?: (a: InvAction, slot: string) => void; focused?: boolean; selected?: string | null; onSelect?: (slot: string) => void; exposed?: boolean;
}) {
  const L = getLocale();
  const treasure = view.inventory.reduce((a, it) => a + (it.value ?? 0), 0);
  const lifeline = lifelineEffectText(catalog.rules?.lifeline?.turns);
  return (
    <section class={`panel inv ${focused ? 'focused' : ''}`}>
      <h3>
        {tr('所持品', 'Inventory')} <small title={tr('帰還の綱は所持数に数えない', 'The lifeline does not count toward capacity')}>{carriedCount(view, catalog)}/{view.self.capacity}</small>
        {treasure > 0 && <small class="treasure" title={tr('持ち帰ると戦利品として確定する（落とすと減る）', 'Banked as haul when you extract (dropping it removes it)')}>{tr(`宝 計 ${treasure}`, `treasure ${treasure}`)}</small>}
      </h3>
      {view.inventory.length === 0 && <div class="muted">{tr('なし', 'empty')}</div>}
      <ul>
        {view.inventory.map((it) => {
          const ci = it.kind ? catalog.items[it.kind] : undefined;
          const cat = ci?.category ?? (it.appearanceId ? catalog.appearances[it.appearanceId]?.category : undefined);
          const usable = cat === 'potion' || cat === 'scroll' || ci?.usable;
          // 手放せない品（帰還の綱）: 置く・投げるは出さない
          const bound = !!ci?.bound;
          const throwable = !bound && (ci?.throwable || cat === 'throwing' || cat === 'potion');
          const name = itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes);
          // 鑑定済みの自分の持ち物は性能をそのまま見せる（V3-2R §14.3）。武器の特性・重い鎧・装飾品の修正も（V3-4）
          const st = itemStats(catalog, it.kind, it.affixes);
          const stats = itemStatsText(L, st, catalog);
          const traits = (st?.weapon?.traits ?? []).map((id) => catalog.weaponTraits[id]).filter((x) => !!x)
            .map((x) => `${nameOf(x.name, L, '')}: ${nameOf(x.desc, L, '')}`);
          // 呪い（V3-4）: 呪われている（装備中は外せない）か、呪いの有無をまだ確かめていない装備品か
          const curse = isCursedItem(catalog, it.affixes) ? 'cursed' as const : curseUnknown(catalog, it) ? 'unknown' as const : null;
          const curseTag = curse ? curseLabel(curse, !!it.equipped) : null;
          const stuck = curse === 'cursed' && !!it.equipped;
          // 同じ部位に呪われた装備があると付け替えられない
          const slotStuck = !!ci?.slot && !it.equipped && view.inventory.some((x) => x.equipped === ci.slot && isCursedItem(catalog, x.affixes));
          const desc = ci ? nameOf(ci.desc, L, '') : tr('未鑑定', 'unidentified');
          // 装備中の品と種類が同じで性能が同じか下の装備は「装備」を出さない（観測の valid_actions と同じ。V3-2R3 §20.6）
          const worse = !!ci?.slot && !it.equipped && sameOrWorseEquip(view, catalog, it);
          // 使う間に隣の敵が行動する（帰還の綱は除く: 即時なら使った手番で盤面を離れる）
          const risky = !!exposed && !bound;
          return (
            <li key={it.id} class={`${selected === it.slot ? 'sel' : ''} ${bound ? 'bound' : ''}`} onClick={() => onSelect?.(it.slot)} title={[desc, ...traits].join('\n')}>
              <span class="slot">{it.slot})</span>
              <span class="name">
                {name}{it.qty > 1 ? ` x${it.qty}` : ''}{it.equipped ? <em> [{tr('装備', 'eq')}]</em> : null}{it.kind === null ? <em class="muted"> ?</em> : null}{cat === 'relic' ? <em class="relic"> ［{tr('遺物', 'relic')}］</em> : null}{it.value !== undefined ? <em class="treasure"> ［{tr(`宝・価値 ${it.value}`, `treasure ${it.value}`)}］</em> : null}
                {bound && <em class="bound"> ［{tr('手放せない・所持数に数えない', 'bound, not counted')}］</em>}
                {curseTag && <em class={`curse ${curse}`} title={curseTag.title}> ［{curseTag.text}］</em>}
                {worse && <em class="worse" title={tr('装備中の品と同じ種類で、性能が同じか下（装備しても良くならない）', 'Same kind as your equipped item, with the same or worse stats (equipping it gains nothing)')}> ［{tr('装備中と同じか劣る', 'same or worse')}］</em>}
                {stats && <span class="istats">{stats}</span>}
              </span>
              {onAction && (
                <span class="acts">
                  {usable && (
                    <button class={`tiny ${bound ? 'lifeline' : ''} ${risky ? 'exposed' : ''}`} onClick={(e) => { e.stopPropagation(); onAction('use', it.slot); }}
                      title={bound ? tr(`帰還の綱を使う（L）: ${lifeline}。確認が出る`, `Use the lifeline (L): ${lifeline}. Asks to confirm`)
                        : risky ? tr('使う間に隣の敵が行動する', 'Adjacent enemies act while you use it') : undefined}>
                      {bound ? tr('綱を使う', 'Use') : tr('使う', 'Use')}{risky ? ' ⚠' : ''}
                    </button>
                  )}
                  {ci?.slot && !it.equipped && !worse && (
                    <button class="tiny" disabled={slotStuck} title={slotStuck ? tr('その部位の装備が呪われていて外せない', 'The item in that slot is cursed and cannot be removed') : curseTag?.title}
                      onClick={(e) => { e.stopPropagation(); onAction('equip', it.slot); }}>{tr('装備', 'Equip')}{curse === 'cursed' ? ' ⚠' : curse ? ' ?' : ''}</button>
                  )}
                  {it.equipped && (
                    <button class="tiny" disabled={stuck} title={stuck ? cursedRemoveText() : undefined} onClick={(e) => { e.stopPropagation(); onAction('unequip', it.slot); }}>{tr('外す', 'Remove')}</button>
                  )}
                  {throwable && !it.equipped && <button class="tiny" onClick={(e) => { e.stopPropagation(); onAction('throw', it.slot); }}>{tr('投げる', 'Throw')}</button>}
                  {!bound && (
                    <button class="tiny" disabled={stuck} title={stuck ? cursedRemoveText() : undefined} onClick={(e) => { e.stopPropagation(); onAction('drop', it.slot); }}>{tr('置く', 'Drop')}</button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface LogLine { seq: number; text: string; kind?: 'error' | 'info' | 'chat' | 'thought' }

export function MessageLog({ lines, title }: { lines: LogLine[]; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, lines[lines.length - 1]?.seq]);
  return (
    <section class="panel log">
      <h3>{title ?? tr('メッセージ', 'Messages')}</h3>
      <div class="lines" ref={ref}>
        {lines.slice(-200).map((l, i) => <div key={`${l.seq}-${i}`} class={`line ${l.kind ?? ''}`}>{l.text}</div>)}
      </div>
    </section>
  );
}

/** 先頭に出して強調する警告（1 手で倒されうる・HP が危険域） */
const URGENT_ALERTS: readonly string[] = ['lethal_range', 'critical_hp'];
/**
 * 並べる順（先頭から）。2 手で倒されうる（V3-2R3 §20.4）は危険の直後、
 * 群れの被害見込みと逃げ道の見込みはその後に置く（V3-2R2 §18.1・§18.2）
 */
const ALERT_ORDER: readonly string[] = [...URGENT_ALERTS, 'lethal_2turns', 'incoming', 'escape'];

/** onEscape: 逃げ道の見込み（escape）に「退く」ボタンを添える。data.stairs は向かう階段（up / down） */
export function AlertsBar({ alerts, onEscape }: { alerts: Alert[]; onEscape?: (stairs: 'up' | 'down') => void }) {
  if (!alerts.length) return null;
  const rank = (a: Alert) => { const i = ALERT_ORDER.indexOf(a.code); return i < 0 ? ALERT_ORDER.length : i; };
  const sorted = [...alerts].sort((a, b) => rank(a) - rank(b));
  return (
    <div class="alerts">
      {sorted.map((a) => {
        const stairs = a.code === 'escape' && (a.data?.stairs === 'up' || a.data?.stairs === 'down') ? a.data.stairs : null;
        // 追われたままなら最悪の被害（V3-2R3b §23.1）。HP 以上なら綱（L）を先に考える
        const worst = stairs && typeof a.data?.worst_if_chased === 'number' ? a.data.worst_if_chased : null;
        const deadly = worst !== null && typeof a.data?.hp === 'number' && worst >= a.data.hp;
        return (
          <span key={a.code} class={`alert ${a.code} ${URGENT_ALERTS.includes(a.code) ? 'urgent' : ''}`}>
            {a.code === 'lethal_range' || a.code === 'lethal_2turns' ? `⚠ ${a.text}` : a.text}
            {stairs && onEscape && (
              <button class={`tiny flee aact ${deadly ? 'danger' : ''}`} onClick={() => onEscape(stairs)}
                title={tr('その階段まで退く（flee: 隣に敵がいても動く。途中で攻撃は受ける）。着いたら extract（E）か階段（>）', 'Flee to those stairs (moves even with an enemy adjacent; you will be attacked). Then extract (E) or take the stairs (>)')
                  + (deadly ? tr('。追われたままなら HP 以上の被害になりうる: 帰還の綱（L）も考える', '. Being chased all the way could cost your HP: consider the lifeline (L)') : '')}>
                {stairs === 'up' ? tr('上り階段へ退く', 'Flee up') : tr('下り階段へ退く', 'Flee down')}
                {stairs && (worst !== null ? tr(`（追われたままなら最悪 ${worst}）`, ` (worst ${worst} if chased)`) : typeof a.data?.path_len === 'number' ? tr('（最悪の被害は不明）', ' (worst unknown)') : '')}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** その種族から受けた最大の一撃 */
export function worstHitText(w: number | null): string {
  return w === null ? tr('一撃の大きさは不明', 'hit size unknown') : tr(`最大の一撃 ${w}`, `worst hit ${w}`);
}

const AWARE_LABEL: Record<string, [string, string]> = { asleep: ['睡眠中', 'asleep'], unaware: ['未察知', 'unaware'], hunting: ['追跡中', 'hunting'] };
const HP_LABEL: Record<string, [string, string]> = { healthy: ['健康', 'healthy'], wounded: ['軽傷', 'wounded'], badly_wounded: ['重傷', 'badly wounded'], near_death: ['瀕死', 'near death'] };

/** 追跡中で逃げておらず、動く相手（fight で「迎え撃つ」: 隣に来るまで待てる。V3-2R2 §18.5） */
export function isApproaching(m: ObsMonster): boolean {
  return m.awareness === 'hunting' && !m.fleeing && !m.traits.includes('stationary');
}

/**
 * 自分に届く追跡中の敵か（逃げておらず、動かない敵は隣にいるときだけ）。観測の incoming / lethal_range と同じ数え方
 */
function reachesYou(m: ObsMonster): boolean {
  return m.awareness === 'hunting' && !m.fleeing && !(m.traits.includes('stationary') && m.dist > 1);
}

/**
 * 見えている敵（観測の visible.monsters）。脅威・最大の一撃と 1 手番あたりの最悪の被害・体格と速さと見れば分かる特徴・
 * 命中と通りの記録・推定残り HP・投擲の可否を並べる。
 * 届く追跡中の敵で、1 手番の最悪の被害（worst_turn）が今の HP 以上なら「1 手で」、2 倍で HP 以上なら「2 手で」倒されうる印を付ける。
 * onFight(id): 隣の相手には「戦う」、追跡中で届かない相手には「迎え撃つ」（隣に来るまで待つ）。
 * onFight(id, slot): 「投擲で決着」（その品を投げ続ける。射程と射線が通るまで待つ）。throwSlotFor が投げる品のスロットを返す相手だけに出す。
 * onReach(id): 長柄で 2 マス先から突く（attack。reach に入っている相手だけ。V3-4 §4.4）
 */
export function MonstersPanel({ monsters, hp, onFight, throwSlotFor, reach, onReach }: {
  monsters: ObsMonster[]; hp: number; onFight?: (id: string, withSlot?: string) => void; throwSlotFor?: (m: ObsMonster) => string | null;
  reach?: ReadonlySet<string>; onReach?: (id: string) => void;
}) {
  if (!monsters.length) return null;
  const L = getLocale();
  return (
    <section class="panel mons">
      <h3>{tr('見えている敵', 'Enemies in view')} <small>{monsters.length}</small></h3>
      <ul>
        {monsters.map((m) => {
          const aw = AWARE_LABEL[m.awareness];
          const hs = HP_LABEL[m.hp_state];
          const wt = reachesYou(m) ? m.worst_turn : null;
          const lethal = wt !== null && wt >= hp;
          const lethal2 = wt !== null && !lethal && wt * 2 >= hp;
          const clear = m.shots.filter((s) => s.state === 'clear').map((s) => s.slot);
          const far = m.shots.filter((s) => s.state === 'out_of_range').map((s) => s.slot);
          const shot = m.shot === 'blocked' ? tr('射線: 通らない', 'shot: blocked')
            : m.shots.length ? [clear.length ? tr(`投擲可: ${clear.join(',')}`, `throw: ${clear.join(',')}`) : '', far.length ? tr(`射程外: ${far.join(',')}`, `out of range: ${far.join(',')}`) : ''].filter(Boolean).join(' / ')
              : '';
          const speed = monsterSpeedLabel(m.speed);
          const looks = monsterLooksText(m);
          const hits = hitsText(L, m.hits);
          const dealt = dealtText(L, m.dealt);
          const perTurn = worstTurnText(m);
          const meet = m.dist > 1 && isApproaching(m);
          const withSlot = throwSlotFor?.(m) ?? null;
          const strike = !!onReach && !!reach?.has(m.id);
          return (
            <li key={m.id} class={`${lethal ? 'lethal' : lethal2 ? 'lethal2' : ''} ${m.role ?? ''}`}>
              <div class="mhead">
                <b>{m.name}{m.objective ? tr('［目的］', ' [objective]') : ''}</b>
                {m.guardian && <span class="mgname">{tr(`「${m.guardian.name}」`, `"${m.guardian.name}"`)}</span>}
                {m.first_seen && <span class="mfirst" title={tr('このランで初めて見た種族', 'A species you meet for the first time this run')}>{tr('初見', 'new')}</span>}
                <small>{dirLabel(L, m.dir)} {m.dist}</small>
                {aw && <span class={`maw ${m.awareness}`}>{tr(aw[0], aw[1])}{m.fleeing ? tr('・逃走中', ', fleeing') : ''}</span>}
                {hs && <span class={`mhp ${m.hp_state}`}>{tr(hs[0], hs[1])}</span>}
                {((onFight && (m.dist === 1 || meet || withSlot)) || strike) && (
                  <span class="right macts">
                    {strike && (
                      <button class="tiny fight" onClick={() => onReach!(m.id)} title={reachAttackTitle()}>{tr('突く', 'Strike')}</button>
                    )}
                    {onFight && m.dist === 1 && (
                      <button class="tiny" onClick={() => onFight(m.id)} title={tr('倒れる・離れる・HP が半分を下回るまで殴り続ける（F）', 'Keep attacking until it falls, moves away, or your HP drops below half (F)')}>
                        {tr('戦う', 'Fight')}
                      </button>
                    )}
                    {onFight && meet && (
                      <button class="tiny" onClick={() => onFight(m.id)} title={tr('隣に来るまで待ち（最大 10 手番）、来たら殴り続ける（F）。HP が半分を下回る・別の追跡中の敵で止まる', 'Wait until it comes adjacent (up to 10 turns), then keep attacking (F). Stops below half HP or on another hunting enemy')}>
                        {tr('迎え撃つ', 'Meet')}
                      </button>
                    )}
                    {onFight && withSlot && (
                      <button class="tiny" onClick={() => onFight(m.id, withSlot)} title={tr(`${withSlot} を倒れるまで投げ続ける（射程と射線が通るまで待つ）。隣に来た・品が尽きた・射線が 3 手番通らない・HP が半分を下回ると止まる`, `Keep throwing ${withSlot} until it falls (waits for range and a clear line). Stops when it comes adjacent, you run out, the line stays blocked for 3 turns, or HP drops below half`)}>
                        {tr(`投擲で決着（${withSlot}）`, `Throw it down (${withSlot})`)}
                      </button>
                    )}
                  </span>
                )}
              </div>
              {m.intent && (
                <div class={`mintent ${m.intent.on_line ? 'online' : ''}`} title={tr('予備動作: 次の手番に大きな行動を取る（見えている間だけ分かる）', 'Intent: a big move comes next turn (shown only while you can see it)')}>
                  {tr('予備動作: ', 'Intent: ')}{m.intent.text}
                </div>
              )}
              {m.guardian && (m.guardian.types.length > 0 || m.guardian.weakness) && (
                <div class="mguard">
                  {m.guardian.types.length > 0 && <span>{tr('型: ', 'type: ')}{m.guardian.types.map((x) => x.name).join(tr('・', '/'))}</span>}
                  <span>{tr('弱点: ', 'weakness: ')}{m.guardian.weakness ? m.guardian.weakness.name : tr('不明', 'unknown')}</span>
                </div>
              )}
              <div class="msub">
                <span class={`mthreat ${m.threat === null ? 'unknown' : `t${m.threat}`}`}>{threatText(m.threat, m.first_seen)}</span>
                <span class={`mworst ${lethal ? 'lethal' : lethal2 ? 'lethal2' : ''}`}
                  title={tr('最大の一撃: その相手（守護者は守護者の記録）から受けた最大の被害。1 手に最悪: それ × あなたの 1 手番に相手が行動する回数（速い相手は 2 回）',
                    'Worst hit: the most damage it (or, for a guardian, the guardian record) has dealt you in one blow. Worst per turn: that times how often it acts during one of your turns (twice if it is faster)')}>
                  {worstHitText(m.worst_hit)}{perTurn ? tr(`（${perTurn}）`, ` (${perTurn})`) : ''}
                  {lethal ? tr('・1 手で HP 以上', ', >= your HP in one turn') : lethal2 ? tr('・2 手で HP 以上', ', >= your HP in two turns') : ''}
                </span>
                {speed && <span class={`mspeed ${m.speed}`} title={tr('自分の今の速さとの比較（見れば分かる）', 'Compared with your current speed (visible at a glance)')}>{speed}</span>}
                {looks && <span class="mtraits" title={tr('見れば分かる性質（体格・群れる・飛び道具・動かない・重装）', 'Visible at a glance (size, pack, ranged, stationary, armored)')}>{looks}</span>}
                {hits && <span class="mhits" title={tr('記録した命中の回数（確率ではない）', 'Recorded hits / tries (not a probability)')}>{hits}</span>}
                {dealt && <span class="mdealt" title={tr('通り: 自分の攻撃が当たったときの実ダメージの平均と回数（装甲の値は伏せたまま。近接と投擲を比べられる）', 'Your hits: average damage when they land, and how many (armor stays hidden; compare melee and throws)')}>{dealt}</span>}
                {m.hp_left_est && <span>{hpEstimateText(L, m.hp_left_est)}</span>}
                {m.damage_seen ? <span>{tr(`見た被害 ${m.damage_seen}`, `dmg seen ${m.damage_seen}`)}</span> : null}
                {shot && <span class={m.shot === 'blocked' ? 'mshot blocked' : 'mshot'}>{shot}</span>}
                {m.bounty ? <span class="mbounty">{tr(`賞金 ${m.bounty}`, `bounty ${m.bounty}`)}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PartyPanel({ world, catalog, follow, onFollow }: { world: World; catalog: Catalog; follow: string | null; onFollow?: (pid: string) => void }) {
  const L = getLocale();
  return (
    <section class="panel">
      <h3>{tr('パーティ', 'Party')}</h3>
      <ul class="party">
        {world.playerOrder.map((pid, i) => {
          const p = world.players[pid];
          const e = world.entities[p.entityId];
          const depth = e?.pos ? world.floors[e.pos.floor]?.depth : null;
          const hs = e?.stats ? hpState(e.stats.hp, e.stats.maxHp) : null;
          return (
            <li key={pid} class={follow === pid ? 'sel' : ''} onClick={() => onFollow?.(pid)}>
              <span class="dot" style={{ background: PLAYER_COLORS[i % PLAYER_COLORS.length] }} />
              <b>{p.name}</b> <small>{kindName(catalog, L, p.classId)} Lv{e?.level?.level ?? 1}</small>
              <span class={`tag ${p.controller.kind}`}>{p.controller.kind === 'agent' ? 'AI' : tr('人間', 'human')}</span>
              <div class="sub">
                {p.state === 'alive'
                  ? <>{depth ? `${tr('地下', 'B')}${depth}` : ''} {e?.stats && <HpBar hp={e.stats.hp} max={e.stats.maxHp} />} {hs && <span class="muted">{hs}</span>}</>
                  : p.state === 'at_camp'
                    ? <span class="pstate at_camp">{playerStateLabel(p.state)}</span>
                    : <span class="muted">{playerStateLabel(p.state)}{p.stats.deathCause ? ` (${kindName(catalog, L, p.stats.deathCause)})` : ''}</span>}
                {((p.stats.expeditions ?? 0) > 0 || (p.stats.banked ?? 0) > 0) && (
                  <span class="muted">
                    {tr(`確定 ${p.stats.banked ?? 0}・遠征達成 ${p.stats.expeditions ?? 0}`, `banked ${p.stats.banked ?? 0}, ${p.stats.expeditions ?? 0} expeditions`)}
                    {p.stats.lost ? tr(`・失 ${p.stats.lost}`, `, lost ${p.stats.lost}`) : ''}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface ThoughtLine { seq: number; player: string; name: string; text: string }

export function AiPanel({ thoughts, activities, commands, observationText }: {
  thoughts: ThoughtLine[]; activities?: AgentActivity[]; commands?: CommandRecord[]; observationText: string | null;
}) {
  const [tab, setTab] = useState<'thought' | 'calls' | 'obs'>('thought');
  return (
    <section class="panel ai">
      <h3>
        {tr('AI パネル', 'AI panel')}
        <span class="tabs">
          <button class={`tiny ${tab === 'thought' ? 'on' : ''}`} onClick={() => setTab('thought')}>{tr('思考', 'Thoughts')}</button>
          <button class={`tiny ${tab === 'calls' ? 'on' : ''}`} onClick={() => setTab('calls')}>{tr('ツール呼び出し', 'Tool calls')}</button>
          <button class={`tiny ${tab === 'obs' ? 'on' : ''}`} onClick={() => setTab('obs')}>{tr('観測テキスト', 'Observation')}</button>
        </span>
      </h3>
      {tab === 'thought' && (
        <div class="lines">
          {thoughts.length === 0 && <div class="muted">{tr('まだ thought はありません', 'No thoughts yet')}</div>}
          {thoughts.slice(-30).reverse().map((t) => <div key={t.seq} class="line thought"><b>{t.name}</b> <small>#{t.seq}</small><br />{t.text}</div>)}
        </div>
      )}
      {tab === 'calls' && (
        <div class="lines">
          {activities && activities.slice(-20).reverse().map((a, i) => (
            <details key={`${a.seq}-${i}`} class="call">
              <summary><code>{a.tool}</code> {JSON.stringify(a.args)} <small>#{a.seq}</small></summary>
              <pre>{a.text}</pre>
            </details>
          ))}
          {commands && commands.slice(-20).reverse().map((c) => (
            <div key={c.cseq} class="call"><code>{c.command.type}</code> {JSON.stringify(c.command)} <small>{c.source} #{c.resultSeq?.[0] ?? '-'}</small>{c.thought ? <div class="thought">💭 {c.thought}</div> : null}</div>
          ))}
          {!activities?.length && !commands?.length && <div class="muted">{tr('記録なし', 'None')}</div>}
        </div>
      )}
      {tab === 'obs' && <pre class="obs">{observationText ?? tr('（プレイヤーを選択）', '(select a player)')}</pre>}
    </section>
  );
}

export function SummaryDialog({ summary, catalog, onClose }: { summary: RunSummary; catalog: Catalog | null; onClose: () => void }) {
  const L = getLocale();
  const v2 = summary.scoreVersion === 2;
  return (
    <div class="modal" onClick={onClose}>
      <div class="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('冒険の記録', 'Run summary')}</h2>
        <p class="muted">{summary.reason}{summary.seed ? ` / seed: ${summary.seed}` : ''}</p>
        <table>
          <thead><tr>
            <th>{tr('名前', 'Name')}</th>
            <th title={v2 ? tr('持ち帰って確定した点の合計', 'Points banked by extracting') : tr('旧スコア（版1: 深度などから計算）', 'Old score (v1: depth-based)')}>{v2 ? tr('確定点', 'Banked') : tr('スコア（版1）', 'Score (v1)')}</th>
            <th>{tr('遠征達成', 'Expeditions')}</th><th>{tr('到達', 'Deepest')}</th><th>Lv</th><th>{tr('撃破', 'Kills')}</th><th>{tr('手数', 'Turns')}</th><th>{tr('状態', 'State')}</th><th>{tr('死因', 'Cause')}</th>
          </tr></thead>
          <tbody>
            {summary.players.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td><b>{v2 ? (p.banked ?? p.score) : p.score}</b></td><td>{p.expeditions ?? 0}</td><td>{p.deepest}</td><td>{p.level}</td><td>{p.kills}</td><td>{p.turns}</td><td>{playerStateLabel(p.state)}</td><td>{p.deathCause ? (catalog ? kindName(catalog, L, p.deathCause) : p.deathCause) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {summary.expeditions && summary.expeditions.length > 0 && (
          <>
            <h3>{tr('遠征の記録', 'Expeditions')}</h3>
            <table>
              <thead><tr><th>#</th><th>{tr('目的', 'Objective')}</th><th>{tr('結果', 'Result')}</th><th>{tr('基礎点', 'Points')}</th></tr></thead>
              <tbody>
                {summary.expeditions.map((x) => (
                  <tr key={x.no}><td>{x.no}</td><td>{objectiveText(L, x.objective)}</td><td>{endReasonText(L, x.endReason)}</td><td>{x.endReason === 'completed' ? `+${x.points}` : '-'}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div class="row">
          <a class="button" href={`#/replay/${summary.runId}`}>{tr('リプレイを見る', 'Watch replay')}</a>
          <a class="button" href="#/">{tr('ロビーへ', 'Lobby')}</a>
          <button onClick={onClose}>{tr('閉じる', 'Close')}</button>
        </div>
      </div>
    </div>
  );
}

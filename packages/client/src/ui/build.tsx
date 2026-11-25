// ビルドの表示と操作（V3-4）: 特技の候補・能動技の並び・方向の選択。
// 状態は観測（self.perk_choice / self.abilities）と公開カタログから。判定（使えるか・届くか）はサーバーが最終的に行う。
import type { Catalog, CatalogAbility, Dir, Observation } from '@muse/shared';
import { nameOf } from '@muse/shared';
import { getLocale, tr } from '../util';
import { abilityReady, abilityStateLabel, abilityTargetLabel, DIR_ARROW, perkChoiceHead, perkChoiceNote, type ObsAbility } from './labels';

type PerkChoice = NonNullable<Observation['self']['perk_choice']>;

/** 能動技の定義（観測の id は短い ID: 'bash' → 'core:bash'） */
export function abilityDef(catalog: Catalog | null | undefined, id: string): CatalogAbility | undefined {
  if (!catalog) return undefined;
  return catalog.abilities[id] ?? Object.entries(catalog.abilities).find(([k]) => k.endsWith(`:${id}`))?.[1];
}

/** 能動技の表示名（UI の言語。カタログに無ければ観測の名前） */
export function abilityDisplayName(catalog: Catalog | null | undefined, a: Pick<ObsAbility, 'id' | 'name'>): string {
  return nameOf(abilityDef(catalog, a.id)?.name, getLocale(), a.name);
}

/** 特技の系統の表示名（common は共通、ほかは職業の系統） */
export function lineageDisplayName(catalog: Catalog | null | undefined, classId: string, lineage: string | undefined, fallback: string): string {
  if (!catalog || !lineage) return fallback;
  if (lineage === 'common') return tr('共通', 'common');
  const l = catalog.classes[classId]?.lineages?.find((x) => x.id === lineage);
  return l ? nameOf(l.name, getLocale(), fallback) : fallback;
}

/** 加護の候補（大守護者を倒した。choose_boon。手番を使わない。V3-3 §3.2） */
export function BoonChoicePanel({ choice, catalog, onChoose }: {
  choice: { options: string[]; depth: number }; catalog: Catalog | null | undefined; onChoose: (option: number) => void;
}) {
  const L = getLocale();
  return (
    <div class="perkbox focused">
      <div class="phead"><b>{tr(`加護を 1 つ選ぶ（地下${choice.depth}階の大守護者）`, `Choose a boon (warden of depth ${choice.depth})`)}</b></div>
      <ul class="perkopts">
        {choice.options.map((id, i) => {
          const b = catalog?.boons?.[id];
          return (
            <li key={id}>
              <div class="pname"><span class="pidx">{i + 1}</span><b>{nameOf(b?.name, L, id)}</b></div>
              <div class="pdesc">{nameOf(b?.desc, L, '')}</div>
              <button class="small" onClick={() => onChoose(i + 1)}>{tr('選ぶ', 'Choose')} ({i + 1})</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 特技の候補（choose_perk。手番を使わない。キャンプでも選べる）。
 * focused: キーボードで番号を受け付けている（p）。sent: 選んで返事を待っている間は押せない。
 * collapsed: 「あとで」で畳んだ（1 行だけ出す）。onCollapse を渡さなければ「あとで」は出さない。
 * note: 見出しの補足（省くと遊ぶ画面の補足。持ち主の枠では、キーボードの案内の無い文を渡す。S8）
 */
export function PerkChoicePanel({ choice, catalog, classId, focused, sent, collapsed, onChoose, onCollapse, onExpand, note }: {
  choice: PerkChoice; catalog: Catalog | null | undefined; classId: string; focused?: boolean; sent?: boolean; collapsed?: boolean;
  onChoose: (option: number) => void; onCollapse?: () => void; onExpand?: () => void; note?: string;
}) {
  const L = getLocale();
  if (collapsed && !focused && onExpand) {
    return (
      <div class="perkbox collapsed">
        <span>{perkChoiceHead(choice.level, choice.more)}</span>
        <button class="tiny" onClick={onExpand} title={note ?? perkChoiceNote()}>{tr('開く', 'Open')} (p)</button>
      </div>
    );
  }
  return (
    <div class={`perkbox ${focused ? 'focused' : ''}`}>
      <div class="phead">
        <b>{perkChoiceHead(choice.level, choice.more)}</b>
        <small class="muted">{note ?? perkChoiceNote()}</small>
        {onCollapse && <button class="tiny right" onClick={onCollapse} title={tr('畳む（後で p で開く）', 'Collapse (open later with p)')}>{tr('あとで', 'Later')}</button>}
      </div>
      <ul class="perkopts">
        {choice.options.map((o) => {
          const def = catalog?.perks[o.id];
          const name = def ? nameOf(def.name, L, o.name) : o.name;
          const desc = def ? nameOf(def.desc, L, o.desc) : o.desc;
          const lineage = lineageDisplayName(catalog, classId, def?.lineage, o.lineage);
          const ab = def?.ability ? abilityDef(catalog, def.ability) : undefined;
          return (
            <li key={o.id}>
              <div class="pname">
                <span class="pidx">{o.option}</span>
                <b>{name}</b>
                {lineage && <span class="plin">{lineage}</span>}
                {ab && <span class="pab" title={nameOf(ab.desc, L, '')}>{tr(`能動技: ${nameOf(ab.name, L, '')}`, `ability: ${nameOf(ab.name, L, '')}`)}</span>}
              </div>
              <div class="pdesc">{desc}</div>
              <button class="small" disabled={sent} onClick={() => onChoose(o.option)}>{tr('選ぶ', 'Choose')}{onCollapse ? ` (${o.option})` : ''}</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 能動技の並び（V3-4 §4.2）。押すと使う（対象が要るものは選ばせる）。使えないものは押せない。
 * focused: キーボードで番号を受け付けている（a）
 */
export function AbilityBar({ abilities, catalog, focused, onUse }: {
  abilities: ObsAbility[]; catalog: Catalog | null | undefined; focused?: boolean; onUse: (id: string) => void;
}) {
  if (!abilities.length) return null;
  const L = getLocale();
  return (
    <div class={`abilitybar ${focused ? 'focused' : ''}`}>
      <span class="lbl" title={tr('a を押してから番号で選ぶ', 'Press a, then a number')}>{tr('能動技', 'Abilities')} (a)</span>
      {abilities.map((a, i) => {
        const def = abilityDef(catalog, a.id);
        const ready = abilityReady(a);
        const name = abilityDisplayName(catalog, a);
        const desc = def ? nameOf(def.desc, L, '') : '';
        const cd = def?.cooldown ? tr(`再使用まで ${def.cooldown} 手番`, `cooldown ${def.cooldown} turns`) : '';
        const per = def?.perExpedition ? tr(`遠征ごとに ${def.perExpedition} 回`, `${def.perExpedition} per expedition`) : '';
        return (
          <button key={a.id} class={`small ability ${ready ? 'ready' : 'cooling'}`} disabled={!ready} onClick={() => onUse(a.id)}
            title={[desc, abilityTargetLabel(a.target), [cd, per].filter(Boolean).join(tr('・', ', ')), tr(`キー: a → ${i + 1}`, `Key: a, then ${i + 1}`)].filter(Boolean).join('\n')}>
            <span class="aidx">{i + 1}</span> {name} <small class="astate">{abilityStateLabel(a)}</small>
          </button>
        );
      })}
    </div>
  );
}

const PAD: (Dir | null)[] = ['nw', 'n', 'ne', 'w', null, 'e', 'sw', 's', 'se'];

/** 方向を選ぶ 3×3 のボタン（中央は空き）。passable に無い向きは押せない。away は隣の敵から離れる向き */
export function DirPad({ passable, away, onPick }: { passable: readonly Dir[]; away?: readonly Dir[]; onPick: (d: Dir) => void }) {
  return (
    <div class="dirpad">
      {PAD.map((d, i) => (d
        ? <button key={d} class={`tiny ${away?.includes(d) ? 'away' : ''}`} disabled={!passable.includes(d)} onClick={() => onPick(d)}
          title={away?.includes(d) ? tr('隣の敵から離れる向き', 'Away from the adjacent enemy') : undefined}>{DIR_ARROW[d]}</button>
        : <span key={`c${i}`} />))}
    </div>
  );
}

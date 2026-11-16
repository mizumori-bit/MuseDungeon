// ビルドの表示（V3-4）: 能動技の残り手番と遠征ごとの回数、習熟と装備の命中、武器の特性。
// PlayerView と公開カタログだけから計算する（engine の build.ts と同じ式）。
import type { Catalog, CatalogEquipStats } from './catalog';
import type { PerkOffer } from './types';
import type { ItemView, PlayerView } from './view';

/** 能動技の残りの手番（0 なら使える）と、遠征ごとの回数の残り（無制限なら null） */
export function abilityStatus(view: PlayerView, catalog: Catalog, id: string): { cooldownLeft: number; usesLeft: number | null } {
  const st = view.self.build.abilities.find((a) => a.id === id);
  const def = catalog.abilities[id];
  const left = Math.max(0, (st?.readyAt ?? 0) - view.self.turns);
  if (!def?.perExpedition) return { cooldownLeft: left, usesLeft: null };
  const no = view.expedition?.no ?? 0;
  const used = st && st.usedNo === no ? st.uses ?? 0 : 0;
  return { cooldownLeft: left, usesLeft: Math.max(0, def.perExpedition - used) };
}

/** 能動技・特技の短い ID（'core:bash' → 'bash'、'core:perk_hardy' → 'hardy'） */
export function shortId(id: string): string {
  return (id.split(':')[1] ?? id).replace(/^perk_/, '');
}

function equipped(view: PlayerView): ItemView[] {
  return view.inventory.filter((i) => i.equipped !== null);
}

export function equipStatsOf(catalog: Catalog, it: Pick<ItemView, 'kind'>): CatalogEquipStats | undefined {
  return it.kind ? catalog.items[it.kind]?.equipStats : undefined;
}

/** 習熟（職業）＋装備の、近接・投擲の命中の修正 */
export function accBonuses(view: PlayerView, catalog: Catalog): { melee: number; thrown: number } {
  const cls = catalog.classes[view.self.classId];
  let melee = cls?.proficiency?.melee ?? 0;
  let thrown = cls?.proficiency?.thrown ?? 0;
  for (const it of equipped(view)) {
    const es = equipStatsOf(catalog, it);
    melee += es?.meleeAcc ?? 0;
    thrown += es?.thrownAcc ?? 0;
  }
  return { melee, thrown };
}

/** 装備中の武器の特性 */
export function weaponTraitIds(view: PlayerView, catalog: Catalog): string[] {
  const w = equipped(view).find((i) => i.equipped === 'weapon');
  return w ? equipStatsOf(catalog, w)?.traits ?? [] : [];
}

/** 近接の届く距離（長柄なら 2） */
export function weaponReach(view: PlayerView, catalog: Catalog): number {
  let r = 1;
  for (const id of weaponTraitIds(view, catalog)) r = Math.max(r, catalog.weaponTraits[id]?.reach ?? 1);
  return r;
}

/** 今選べる特技の候補（古い順の最初。選ぶまで後の候補は引かない） */
export function perkChoice(view: PlayerView): PerkOffer | null {
  const o = view.self.build.pending[0];
  return o && o.options.length ? o : null;
}

/** 呪われている（見えている呪いの接辞を持つ）か */
export function isCursedItem(catalog: Catalog, affixes: readonly string[]): boolean {
  return affixes.some((a) => !!catalog.affixes[a]?.cursed);
}

/** 呪いの有無をまだ確かめていない装備品（武器・防具・装飾品）か */
export function curseUnknown(catalog: Catalog, it: Pick<ItemView, 'kind' | 'appearanceId' | 'inspected'>): boolean {
  if (it.inspected) return false;
  if (it.kind) return !!catalog.items[it.kind]?.slot;
  const cat = it.appearanceId ? catalog.appearances[it.appearanceId]?.category : undefined;
  return cat === 'ring' || cat === 'amulet';
}

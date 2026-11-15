// 公開カタログの生成。能力値・出現条件は含めない（プレイヤーが知り得る性質と表示名だけ）。
import type { Catalog, CatalogItem, Names } from '@muse/shared';
import type { Content } from './content';
import type { ItemDef } from './schema';

function itemDesc(it: ItemDef): Names {
  const ja: string[] = [];
  const en: string[] = [];
  if (it.equip) {
    const e = it.equip;
    const slotJa = { weapon: '武器', armor: '防具', accessory: '装飾品' }[e.slot];
    ja.push(slotJa);
    en.push(e.slot);
    if (e.dmg) { ja.push(`ダメージ${e.dmg}`); en.push(`dmg ${e.dmg}`); }
    const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
    if (e.acc) { ja.push(`命中${sign(e.acc)}`); en.push(`acc ${sign(e.acc)}`); }
    if (e.might) { ja.push(`威力${sign(e.might)}`); en.push(`might ${sign(e.might)}`); }
    if (e.armor) { ja.push(`装甲${sign(e.armor)}`); en.push(`armor ${sign(e.armor)}`); }
    if (e.eva) { ja.push(`回避${sign(e.eva)}`); en.push(`eva ${sign(e.eva)}`); }
  }
  if (it.throw) { ja.push(`投擲 ${it.throw.dmg} 射程${it.throw.range}`); en.push(`thrown ${it.throw.dmg} range ${it.throw.range}`); }
  const base: Names = { ja: ja.join(' / '), en: en.join(' / ') };
  if (it.desc) return { ja: [it.desc.ja, base.ja].filter(Boolean).join(' — '), en: [it.desc.en, base.en].filter(Boolean).join(' — ') };
  return base;
}

export function buildCatalog(c: Content): Catalog {
  const items: Record<string, CatalogItem> = {};
  for (const it of c.lists.items) {
    items[it.id] = {
      name: it.name, category: it.category, unidentified: it.unidentified, stack: it.stack,
      slot: it.equip?.slot, usable: it.onUse.length > 0, throwable: !!it.throw || it.shatter,
      targeted: it.target !== 'none', desc: itemDesc(it),
    };
  }
  return {
    contentVersion: c.version,
    terrain: Object.fromEntries(c.terrain.map((t) => [t.id, { name: t.name, passable: t.passable, opaque: t.opaque, layer: t.layer, door: t.door, stairs: t.stairs, tags: t.tags }])),
    monsters: Object.fromEntries(c.lists.monsters.map((m) => [m.id, { name: m.name, tags: m.tags }])),
    classes: Object.fromEntries(c.lists.classes.map((k) => [k.id, { name: k.name, desc: k.desc }])),
    items,
    appearances: Object.fromEntries(c.lists.appearances.map((a) => [a.id, { name: a.name, category: a.category }])),
    features: Object.fromEntries(c.lists.features.map((f) => [f.id, {
      name: f.name, category: f.category, states: f.states, interactable: f.onInteract.length > 0, passable: f.passable,
    }])),
    statuses: Object.fromEntries(Object.values(c.statuses).map((s) => [s.id, { name: s.name }])),
    affixes: Object.fromEntries(c.lists.affixes.map((a) => [a.id, { name: a.name, target: a.target }])),
    biomes: Object.fromEntries(c.lists.biomes.map((b) => [b.id, { name: b.name }])),
    floorTypes: Object.fromEntries(c.lists.floorTypes.map((f) => [f.id, { name: f.name }])),
  };
}

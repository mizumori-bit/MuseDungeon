// 公開カタログの生成。能力値・出現条件は含めない（プレイヤーが知り得る性質と表示名だけ）。
import type { Catalog, CatalogEquipStats, CatalogItem, Names } from '@muse/shared';
import { HP_BANDS } from '@muse/shared';
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
    if (e.maxHp) { ja.push(`最大HP${sign(e.maxHp)}`); en.push(`max HP ${sign(e.maxHp)}`); }
    if (e.sight) { ja.push(`視界${sign(e.sight)}`); en.push(`sight ${sign(e.sight)}`); }
    if (e.meleeAcc) { ja.push(`近接の命中${sign(e.meleeAcc)}`); en.push(`melee acc ${sign(e.meleeAcc)}`); }
    if (e.thrownAcc) { ja.push(`投擲の命中${sign(e.thrownAcc)}`); en.push(`thrown acc ${sign(e.thrownAcc)}`); }
    if (e.moveCost !== 100) { ja.push(`歩く手番のコスト${e.moveCost}`); en.push(`move cost ${e.moveCost}`); }
  }
  if (it.throw) { ja.push(`投擲 ${it.throw.dmg} 射程${it.throw.range}`); en.push(`thrown ${it.throw.dmg} range ${it.throw.range}`); }
  const base: Names = { ja: ja.join(' / '), en: en.join(' / ') };
  if (it.desc) return { ja: [it.desc.ja, base.ja].filter(Boolean).join(' — '), en: [it.desc.en, base.en].filter(Boolean).join(' — ') };
  return base;
}

function equipStats(it: ItemDef): CatalogEquipStats {
  const e = it.equip!;
  const out: CatalogEquipStats = {};
  for (const k of ['acc', 'eva', 'might', 'armor', 'maxHp', 'sight', 'meleeAcc', 'thrownAcc', 'stealthPct', 'wakePct'] as const) if (e[k]) out[k] = e[k];
  if (e.moveCost !== 100) out.moveCost = e.moveCost;
  if (e.noiseWakes) out.noiseWakes = true;
  if (e.traits.length) out.traits = [...e.traits];
  return out;
}

export function buildCatalog(c: Content): Catalog {
  const items: Record<string, CatalogItem> = {};
  for (const it of c.lists.items) {
    items[it.id] = {
      name: it.name, category: it.category, unidentified: it.unidentified, stack: it.stack,
      slot: it.equip?.slot, usable: it.onUse.length > 0, throwable: !!it.throw || it.shatter,
      targeted: it.target !== 'none', desc: itemDesc(it), harmful: it.harmful, treasure: it.category === 'treasure', bound: it.bound,
      throwRange: it.throw?.range ?? (it.shatter ? 4 : null),
      ...(it.equip?.slot === 'weapon' && it.equip.dmg ? { weapon: { dmg: it.equip.dmg, acc: it.equip.acc ?? 0 } } : {}),
      ...(it.equip?.slot === 'armor' ? { armorStats: { armor: it.equip.armor ?? 0, eva: it.equip.eva ?? 0 } } : {}),
      ...(it.throw ? { throwStats: { dmg: it.throw.dmg, acc: it.throw.acc ?? 0, range: it.throw.range } } : {}),
      ...(it.equip ? { equipStats: equipStats(it) } : {}),
    };
  }
  return {
    contentVersion: c.version,
    terrain: Object.fromEntries(c.terrain.map((t) => [t.id, { name: t.name, passable: t.passable, opaque: t.opaque, layer: t.layer, door: t.door, stairs: t.stairs, tags: t.tags }])),
    // size・armored は見れば分かる性質（V3-2R3 §20.4）。armored は素の装甲が 3 以上（値そのものは出さない）
    monsters: Object.fromEntries(c.lists.monsters.map((m) => [m.id, { name: m.name, tags: m.tags, glyph: m.glyph, size: m.size, armored: m.stats.armor >= 3 }])),
    classes: Object.fromEntries(c.lists.classes.map((k) => [k.id, {
      name: k.name, desc: k.desc,
      // 自キャラの初期値と成長は公開情報（キー名 hp は使わない: 能力値を出さないカタログの検査に合わせる）
      base: { maxHp: k.stats.hp, acc: k.stats.acc, eva: k.stats.eva, might: k.stats.might, armor: k.stats.armor, sight: k.stats.sight, speed: k.speed, capacity: k.capacity },
      startItems: k.startItems.map((s) => ({ item: s.item, qty: s.qty, equip: s.equip })),
      growth: { maxHpPerLevel: k.levelUp.hp },
      proficiency: { melee: k.proficiency.melee ?? 0, thrown: k.proficiency.thrown ?? 0 },
      lineages: k.lineages.map((l) => ({ id: l.id, name: l.name })),
      startPerks: [...k.startPerks],
    }])),
    items,
    appearances: Object.fromEntries(c.lists.appearances.map((a) => [a.id, { name: a.name, category: a.category }])),
    features: Object.fromEntries(c.lists.features.map((f) => [f.id, {
      name: f.name, category: f.category, states: f.states, interactable: f.onInteract.length > 0, passable: f.passable,
    }])),
    statuses: Object.fromEntries(Object.values(c.statuses).map((s) => [s.id, s.handler === 'speed_pct' ? { name: s.name, speedPct: s.params.pct ?? 100 } : { name: s.name }])),
    affixes: Object.fromEntries(c.lists.affixes.map((a) => [a.id, {
      name: a.name, target: a.target,
      ...(a.target === 'item' ? { itemMods: { acc: a.mods?.acc ?? 0, dmgBonus: a.mods?.dmgBonus ?? 0, armor: a.mods?.armor ?? 0, eva: a.mods?.eva ?? 0, might: a.mods?.might ?? 0, maxHp: a.mods?.maxHp ?? 0, sight: a.mods?.sight ?? 0 } } : {}),
      ...(a.cursed ? { cursed: true } : {}),
    }])),
    perks: Object.fromEntries(c.lists.perks.map((pk) => [pk.id, {
      name: pk.name, desc: pk.desc, lineage: pk.lineage, maxRanks: pk.maxRanks, requires: [...pk.requires],
      mods: { maxHp: pk.mods.maxHp ?? 0, acc: pk.mods.acc ?? 0, eva: pk.mods.eva ?? 0, might: pk.mods.might ?? 0, armor: pk.mods.armor ?? 0, capacity: pk.mods.capacity ?? 0, stealthPct: pk.mods.stealthPct ?? 0 },
      ...(pk.ability ? { ability: pk.ability } : {}), hooks: pk.hooks.map((h) => h.hook),
    }])),
    abilities: Object.fromEntries(c.lists.abilities.map((ab) => [ab.id, {
      name: ab.name, desc: ab.desc, target: ab.target, cooldown: ab.cooldown, handler: ab.handler, ...(ab.perExpedition ? { perExpedition: ab.perExpedition } : {}),
    }])),
    weaponTraits: Object.fromEntries(c.lists.weaponTraits.map((w) => [w.id, {
      name: w.name, desc: w.desc,
      ...(w.handler === 'reach' ? { reach: w.params.range ?? 2 } : {}), ...(w.handler === 'attack_cost' ? { attackCost: w.params.cost ?? 100 } : {}),
    }])),
    biomes: Object.fromEntries(c.lists.biomes.map((b) => [b.id, { name: b.name }])),
    floorTypes: Object.fromEntries(c.lists.floorTypes.map((f) => [f.id, { name: f.name }])),
    rules: {
      regen: { ...c.balance.regen },
      restMaxTurns: c.balance.rest.maxTurns,
      macroStepLimit: c.balance.macro.stepLimit,
      wander: { intervalMin: c.balance.wander.intervalMin, intervalMax: c.balance.wander.intervalMax },
      score: { ...c.balance.score },
      estimateMinSamples: c.balance.estimate.minSamples,
      haul: {
        overreachFirst: c.balance.haul.overreachFirst, overreachStep: c.balance.haul.overreachStep, overreachPct: { ...c.balance.haul.overreachPct },
        killPerXp: c.balance.haul.killPerXp, killAffixPct: c.balance.haul.killAffixPct,
        withdrawPct: c.balance.haul.withdrawPct, discovery: { ...c.balance.haul.discovery },
        guardianBounty: { ...c.balance.haul.guardianBounty },
      },
      slots: {
        safe: { ...c.balance.expedition.slots.safe },
        standard: { ...c.balance.expedition.slots.standard },
        ambitious: { ...c.balance.expedition.slots.ambitious },
      },
      afterObjectiveWanderPct: c.balance.expedition.afterObjective.wanderIntervalPct,
      recommendedLevel: { byDepth: [...c.balance.expedition.recommendedLevelByDepth] },
      xp: { ...c.balance.xp },
      lifeline: { ...c.balance.lifeline },
      teleport: { ...c.balance.teleport },
      guardianRanks: c.balance.guardian.ranks.map((r) => ({ hpPct: r.hpPct })),
      perkOptions: c.balance.perks.options,
      curseChancePct: c.balance.curse.chancePct,
      traits: Object.fromEntries(c.lists.expeditionTraits.map((t) => [t.id, { name: t.name, desc: t.desc, multiplierPct: t.multiplierPct, danger: t.danger }])),
      expedition: {
        firstTargetDepth: { ...c.balance.expedition.firstTargetDepth },
        typePct: { ...c.balance.expedition.typePct }, depthPct: { ...c.balance.expedition.depthPct },
      },
      hpBands: [HP_BANDS[0], HP_BANDS[1], HP_BANDS[2]],
    },
  };
}

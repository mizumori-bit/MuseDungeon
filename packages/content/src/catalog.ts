// 公開カタログの生成。能力値・出現条件は含めない（プレイヤーが知り得る性質と表示名だけ）。
import type { Catalog, CatalogEquipStats, CatalogItem, Names } from '@muse/shared';
import { GUARDIAN_HANDLER_INTENT, HP_BANDS, PACK_ALERT_RADIUS } from '@muse/shared';
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

/** 由来の 1 文を説明の前に付ける（遺物。V3-3 §3.4） */
function withOrigin(it: ItemDef, d: Names): Names {
  return it.origin ? { ja: `${it.origin.ja}${d.ja}`, en: `${it.origin.en} ${d.en}` } : d;
}

export function buildCatalog(c: Content): Catalog {
  const items: Record<string, CatalogItem> = {};
  for (const it of c.lists.items) {
    items[it.id] = {
      name: it.name, category: it.category, unidentified: it.unidentified, stack: it.stack,
      slot: it.equip?.slot, usable: it.onUse.length > 0, throwable: !!it.throw || it.shatter,
      targeted: it.target !== 'none', desc: withOrigin(it, itemDesc(it)), ...(it.desc ? { note: withOrigin(it, it.desc) } : {}), harmful: it.harmful, treasure: it.category === 'treasure', bound: it.bound,
      throwRange: it.throw?.range ?? (it.shatter ? 4 : null),
      ...(it.equip?.slot === 'weapon' && it.equip.dmg ? { weapon: { dmg: it.equip.dmg, acc: it.equip.acc ?? 0 } } : {}),
      ...(it.equip?.slot === 'armor' ? { armorStats: { armor: it.equip.armor ?? 0, eva: it.equip.eva ?? 0 } } : {}),
      ...(it.throw ? { throwStats: { dmg: it.throw.dmg, acc: it.throw.acc ?? 0, range: it.throw.range } } : {}),
      ...(it.equip ? { equipStats: equipStats(it) } : {}),
      ...(it.boon ? { boon: it.boon } : {}),
      // 使うと HP が回復する（V4-1c §16.2）: 効果の定義から（品の ID を並べない。データで増えたら自動で入る）
      ...((() => {
        const h = it.onUse.find((e) => e.effect === 'heal');
        if (!h) return {};
        const amount = typeof h.amount === 'string' || typeof h.amount === 'number' ? String(h.amount) : '';
        return { heal: { amount, ...(typeof h.minPct === 'number' ? { minPct: h.minPct } : {}) } };
      })()),
      // 未鑑定の手がかり（V3-5 §5.4。2〜3 種で共有する公開の表）
      ...(it.clue ? { clue: it.clue } : {}),
      // 使うと所持品を鑑定する（鑑定の巻物。S1b §12.4 の 8: 対象を付けずに使った結果の文に、対象の選び方を添える）
      ...(it.onUse.some((e) => e.effect === 'identify') ? { identifies: true as const } : {}),
      // 使うと地図を書き足す（地図の巻物・残り頁。S9a §57.3 の 5: 地図に関わらない品を使った結果の文に「地図に載った地形は無かった」が出ていた）
      ...(it.onUse.some((e) => e.effect === 'map') ? { maps: true as const } : {}),
    };
  }
  return {
    contentVersion: c.version,
    terrain: Object.fromEntries(c.terrain.map((t) => [t.id, { name: t.name, passable: t.passable, opaque: t.opaque, layer: t.layer, door: t.door, stairs: t.stairs, tags: t.tags, ...(t.moveCostPct !== 100 ? { moveCostPct: t.moveCostPct } : {}) }])),
    // size・armored・evasive は見れば分かる性質（V3-2R3 §20.4・V3-3b §40.2）。armored は素の装甲が 3 以上、evasive は素の回避が 5 以上（値そのものは出さない）
    // packRadius: 群れる種族の呼び声の届く広さ（1 体が気づくと、このマス数以内の同じ種族が起きる。engine の ai の pack と同じ値。S4 §42.2 の 4）。
    // onHitStatus: 殴られて当たったときに付く状態（錆など。見れば分かる性質の効き目。S4 §42.3 の 1）
    monsters: Object.fromEntries(c.lists.monsters.map((m) => [m.id, {
      name: m.name, tags: m.tags, glyph: m.glyph, size: m.size, armored: m.stats.armor >= 3, evasive: m.stats.eva >= 5, ...(m.desc ? { desc: m.desc } : {}),
      ...(m.ai.archetype === 'pack' ? { packRadius: m.ai.alertRadius ?? PACK_ALERT_RADIUS } : {}),
      ...((): { onHitStatus?: { status: string; turns: string; chancePct?: number }[] } => {
        const list = m.attack.onHit.filter((e) => e.effect === 'status' && typeof e.status === 'string').map((e) => ({ status: e.status as string, turns: String(e.turns ?? ''), ...(e.chancePct !== undefined ? { chancePct: e.chancePct } : {}) }));
        return list.length ? { onHitStatus: list } : {};
      })(),
    }])),
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
      name: f.name, category: f.category, states: f.states, interactable: f.onInteract.length > 0 || !!f.afterInteract || !!f.gamble || f.lever || !!f.burst || f.campfire, passable: f.passable,
      ...(f.campfire ? { campfire: true as const } : {}),
      ...(f.afterInteract ? { afterInteract: f.afterInteract } : {}),
      ...(f.desc ? { desc: f.desc } : {}),
      // 賭けの祭壇の表（確率は % に直して公開。V3-5 §5.1）
      ...(f.gamble ? { gamble: f.gamble.map((g) => ({ name: g.name, pct: Math.trunc((g.weight * 100) / f.gamble!.reduce((a, x) => a + x.weight, 0)) })) } : {}),
    }])),
    statuses: Object.fromEntries(Object.values(c.statuses).map((s) => [s.id, {
      ...(s.handler === 'speed_pct' ? { name: s.name, speedPct: s.params.pct ?? 100 }
        : s.handler === 'stat_mod' ? { name: s.name, ...(s.params.armor ? { armor: s.params.armor } : {}) } : { name: s.name }),
      ...(s.tone ? { tone: s.tone } : {}),
    }])),
    affixes: Object.fromEntries(c.lists.affixes.map((a) => [a.id, {
      name: a.name, target: a.target,
      ...(a.target === 'item' ? { itemMods: { acc: a.mods?.acc ?? 0, dmgBonus: a.mods?.dmgBonus ?? 0, armor: a.mods?.armor ?? 0, eva: a.mods?.eva ?? 0, might: a.mods?.might ?? 0, maxHp: a.mods?.maxHp ?? 0, sight: a.mods?.sight ?? 0 } } : {}),
      ...(a.cursed ? { cursed: true } : {}),
      // 敵の接辞の効き目（V3-8 §53.3: 強敵の見立て。look に出す）
      ...(a.target === 'monster' ? { monsterMods: Object.fromEntries(Object.entries(a.mods ?? {}).filter(([k, v]) => k !== 'xpPct' && v)) } : {}),
    }])),
    perks: Object.fromEntries(c.lists.perks.map((pk) => [pk.id, {
      name: pk.name, desc: pk.desc, lineage: pk.lineage, maxRanks: pk.maxRanks, requires: [...pk.requires],
      mods: { maxHp: pk.mods.maxHp ?? 0, acc: pk.mods.acc ?? 0, eva: pk.mods.eva ?? 0, might: pk.mods.might ?? 0, armor: pk.mods.armor ?? 0, capacity: pk.mods.capacity ?? 0, stealthPct: pk.mods.stealthPct ?? 0 },
      ...(pk.ability ? { ability: pk.ability } : {}), hooks: pk.hooks.map((h) => h.hook),
      // 投擲で無視する装甲（急所狙い。V3-3b §40.1）
      ...(pk.hooks.some((h) => h.hook === 'thrown_dmg') ? { thrownDmg: pk.hooks.filter((h) => h.hook === 'thrown_dmg').reduce((a, h) => a + (Number((h as Record<string, unknown>).dmg) || 0), 0) } : {}),
      ...(pk.hooks.some((h) => h.hook === 'thrown_pierce') ? { thrownPierce: pk.hooks.filter((h) => h.hook === 'thrown_pierce').reduce((a, h) => a + (Number((h as Record<string, unknown>).armor) || 0), 0) } : {}),
    }])),
    abilities: Object.fromEntries(c.lists.abilities.map((ab) => [ab.id, {
      name: ab.name, desc: ab.desc, target: ab.target, cooldown: ab.cooldown, handler: ab.handler, ...(ab.perExpedition ? { perExpedition: ab.perExpedition } : {}),
      // 最大 HP の割合の回復（V4-1c §16.2）
      ...(ab.handler === 'heal_pct' && typeof (ab.params as { pct?: unknown } | undefined)?.pct === 'number' ? { heal: { pct: (ab.params as { pct: number }).pct } } : {}),
      // 動くマスの数（身をかわす。S6 §49.6 の 4。engine の slip と同じ既定 2）
      ...(ab.handler === 'slip' ? { steps: typeof (ab.params as { steps?: unknown } | undefined)?.steps === 'number' ? (ab.params as { steps: number }).steps : 2 } : {}),
    }])),
    guardianTypes: Object.fromEntries(c.lists.guardianTypes.map((g) => [g.id, {
      name: g.name, desc: g.desc, strongVs: g.strongVs, handler: g.handler, ...(g.handler === 'warded' && typeof g.params?.armor === 'number' ? { armor: g.params.armor } : {}),
      // 型が出す予備動作（S5b。handler から）
      ...(GUARDIAN_HANDLER_INTENT[g.handler] ? { intent: GUARDIAN_HANDLER_INTENT[g.handler] } : {}),
    }])),
    guardianWeaknesses: Object.fromEntries(c.lists.guardianWeaknesses.map((w) => [w.id, { name: w.name, desc: w.desc, handler: w.handler, ...(w.short ? { short: w.short } : {}), ...(w.maxArmor !== undefined ? { maxArmor: w.maxArmor } : {}) }])),
    boons: Object.fromEntries(c.lists.boons.map((b) => [b.id, { name: b.name, desc: b.desc, hooks: b.hooks.map((h) => ({ ...h })) }])),
    lore: { frame: c.lists.lore.filter((l) => l.kind === 'frame').map((l) => ({ ...l.text })) },
    weaponTraits: Object.fromEntries(c.lists.weaponTraits.map((w) => [w.id, {
      name: w.name, desc: w.desc,
      ...(w.handler === 'reach' ? { reach: w.params.range ?? 2 } : {}), ...(w.handler === 'attack_cost' ? { attackCost: w.params.cost ?? 100 } : {}),
    }])),
    biomes: Object.fromEntries(c.lists.biomes.map((b) => [b.id, { name: b.name, ...(b.desc ? { desc: b.desc } : {}) }])),
    floorTypes: Object.fromEntries(c.lists.floorTypes.map((f) => [f.id, { name: f.name }])),
    rules: {
      regen: { ...c.balance.regen },
      restMaxTurns: c.balance.rest.maxTurns,
      restCapPct: c.balance.rest.capPct,
      // 階の異変・名前付きの強敵・未鑑定の手がかり（V3-5 §5.3・§5.4）
      floorEventPct: c.balance.floorEvent.chancePct, elite: { chancePct: c.balance.elite.chancePct, minDepth: c.balance.elite.minDepth, affixes: c.balance.elite.affixes }, clueTurns: c.balance.clueTurns, legacyMinKills: c.balance.legacy.minKills,
      guardianAwayHealPct: c.balance.guardian.awayHealPct,
      ...((): { milestone?: { every: number; min: number; boonOptions: number; levelBonus: number; hpRule: { hpPct: number; minHpBase: number; minHpPerDepth: number; maxHpBase: number; maxHpPerDepth: number }; minSpeed: number } } => {
        const f = c.lists.floorTypes.find((x) => x.rules.warden && x.every > 0);
        const wb = c.balance.guardian.warden;
        return f ? { milestone: { every: f.every, min: f.depth.min, boonOptions: wb.boonOptions, levelBonus: wb.levelBonus,
          hpRule: { hpPct: wb.hpPct, minHpBase: wb.minHpBase, minHpPerDepth: wb.minHpPerDepth, maxHpBase: wb.maxHpBase, maxHpPerDepth: wb.maxHpPerDepth }, minSpeed: wb.minSpeed } } : {};
      })(),
      macroStepLimit: c.balance.macro.stepLimit,
      fightLostWait: c.balance.fight.lostWait,
      fightFirstHitStopPct: c.balance.fight.firstHitStopPct,
      fightRecordedKills: c.balance.fight.recordedKills,
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
      seasonFire: { costPerDepth: c.balance.season.fireCostPerDepth, perSeason: c.balance.season.firesPerSeason, spacing: c.balance.season.fireSpacing, supportMinHealPct: c.balance.season.supportMinHealPct, returnTurns: c.balance.season.fireReturnTurns },
      // 補給の置き場（S3 §25.2）
      seasonSupply: { cap: c.balance.season.supplyCap, perExpedition: c.balance.season.supplyTakesPerExpedition },
      teleport: { ...c.balance.teleport },
      guardianRanks: c.balance.guardian.ranks.map((r) => ({ hpPct: r.hpPct, minHpBase: r.minHpBase, minHpPerDepth: r.minHpPerDepth })),
      perkOptions: c.balance.perks.options,
      curseChancePct: c.balance.curse.chancePct,
      traits: Object.fromEntries(c.lists.expeditionTraits.map((t) => [t.id, { name: t.name, desc: t.desc, multiplierPct: t.multiplierPct, danger: t.danger, ...(t.floor ? { floor: { name: t.floor.name, ...(t.floor.detail ? { detail: t.floor.detail } : {}), danger: t.floor.danger } } : {}) }])),
      expedition: {
        firstTargetDepth: { ...c.balance.expedition.firstTargetDepth },
        typePct: { ...c.balance.expedition.typePct }, depthPct: { ...c.balance.expedition.depthPct }, repeatPct: c.balance.expedition.repeatPct, repeatMinPct: c.balance.expedition.repeatMinPct,
      },
      hpBands: [HP_BANDS[0], HP_BANDS[1], HP_BANDS[2]],
    },
  };
}

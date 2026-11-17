// 検証済みコンテンツの束。ID → 定義の表と、決定的な走査用の ID 順リストを持つ。
import { canonicalHash } from '@muse/shared';
import type {
  AbilityDef, AffixDef, AppearanceDef, BalanceDef, BiomeDef, ClassDef, ExpeditionTraitDef, FeatureDef, FileKind, FloorTypeDef, ItemDef,
  LootTableDef, MonsterDef, PerkDef, PrefabDef, SpawnTableDef, StatusDef, TerrainDef, WeaponTraitDef,
  GuardianTypeDef, GuardianWeaknessDef, GuardianNamesDef, BoonDef, LoreDef,
} from './schema';
import { FILE_SCHEMAS } from './schema';

export interface Content {
  version: string;
  packs: string[];
  /** index 0 は必ず core:unknown（記憶地図の「未知」） */
  terrain: TerrainDef[];
  terrainIndex: Record<string, number>;
  monsters: Record<string, MonsterDef>;
  items: Record<string, ItemDef>;
  appearances: Record<string, AppearanceDef>;
  affixes: Record<string, AffixDef>;
  statuses: Record<string, StatusDef>;
  biomes: Record<string, BiomeDef>;
  floorTypes: Record<string, FloorTypeDef>;
  prefabs: Record<string, PrefabDef>;
  spawnTables: Record<string, SpawnTableDef>;
  lootTables: Record<string, LootTableDef>;
  classes: Record<string, ClassDef>;
  features: Record<string, FeatureDef>;
  /** 調整値（core:balance。後の pack が同じ ID で上書きできる） */
  balance: BalanceDef;
  expeditionTraits: Record<string, ExpeditionTraitDef>;
  /** ビルド（V3-4）: 特技・能動技・武器の特性 */
  perks: Record<string, PerkDef>;
  abilities: Record<string, AbilityDef>;
  weaponTraits: Record<string, WeaponTraitDef>;
  /** 守護者（V3-3）: 型・弱点・名前の音節 */
  guardianTypes: Record<string, GuardianTypeDef>;
  guardianWeaknesses: Record<string, GuardianWeaknessDef>;
  guardianNames: Record<string, GuardianNamesDef>;
  /** 加護（V3-3 §3.3） */
  boons: Record<string, BoonDef>;
  /** 物語の文（V3-3 §3.4） */
  lore: Record<string, LoreDef>;
  /** 各表の ID 昇順リスト（決定的な走査用） */
  lists: {
    monsters: MonsterDef[]; items: ItemDef[]; appearances: AppearanceDef[]; affixes: AffixDef[];
    biomes: BiomeDef[]; floorTypes: FloorTypeDef[]; prefabs: PrefabDef[]; classes: ClassDef[]; features: FeatureDef[];
    expeditionTraits: ExpeditionTraitDef[]; perks: PerkDef[]; abilities: AbilityDef[]; weaponTraits: WeaponTraitDef[];
    guardianTypes: GuardianTypeDef[]; guardianWeaknesses: GuardianWeaknessDef[]; boons: BoonDef[]; lore: LoreDef[];
    /** 加護を持つ遺物（category: relic で boon のある品） */
    relics: ItemDef[];
  };
  /** 定義済みの最深の出現深度（深層スケーリングの基準） */
  deepestDefined: number;
}

export type RawPack = { id: string; files: Partial<Record<FileKind, unknown[]>> };

export class ContentError extends Error {}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function table<T extends { id: string }>(items: T[], kind: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const it of items) {
    if (out[it.id]) throw new ContentError(`${kind}: ID が重複: ${it.id}`);
    out[it.id] = it;
  }
  return out;
}

/** 生データ（pack ごとの JSON 配列）を検証して Content にする。後の pack が同じ ID を上書きできる */
export function buildContent(packs: RawPack[]): Content {
  const merged: Record<FileKind, Map<string, any>> = Object.fromEntries(
    (Object.keys(FILE_SCHEMAS) as FileKind[]).map((k) => [k, new Map<string, any>()]),
  ) as Record<FileKind, Map<string, any>>;
  for (const pack of packs) {
    for (const kind of Object.keys(pack.files) as FileKind[]) {
      const schema = FILE_SCHEMAS[kind];
      if (!schema) throw new ContentError(`未知の定義ファイル: ${pack.id}/${kind}.json`);
      const arr = pack.files[kind] ?? [];
      if (!Array.isArray(arr)) throw new ContentError(`${pack.id}/${kind}.json は配列であること`);
      arr.forEach((raw, i) => {
        const r = (schema as any).safeParse(raw);
        if (!r.success) {
          throw new ContentError(`${pack.id}/${kind}.json[${i}] ${(raw as any)?.id ?? ''}: ${r.error.issues.map((x: any) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
        }
        merged[kind].set(r.data.id, r.data);
      });
    }
  }
  const list = <K extends FileKind>(k: K) => [...merged[k].values()].sort(byId);

  const terrainAll = list('terrain') as TerrainDef[];
  const unknown = terrainAll.find((t) => t.id === 'core:unknown');
  if (!unknown) throw new ContentError('terrain に core:unknown が必要');
  const terrain = [unknown, ...terrainAll.filter((t) => t.id !== 'core:unknown')];
  const terrainIndex: Record<string, number> = {};
  terrain.forEach((t, i) => { terrainIndex[t.id] = i; });

  const c: Content = {
    version: '',
    packs: packs.map((p) => p.id),
    terrain,
    terrainIndex,
    monsters: table(list('monsters') as MonsterDef[], 'monsters'),
    items: table(list('items') as ItemDef[], 'items'),
    appearances: table(list('appearances') as AppearanceDef[], 'appearances'),
    affixes: table(list('affixes') as AffixDef[], 'affixes'),
    statuses: table(list('statuses') as StatusDef[], 'statuses'),
    biomes: table(list('biomes') as BiomeDef[], 'biomes'),
    floorTypes: table(list('floorTypes') as FloorTypeDef[], 'floorTypes'),
    prefabs: table(list('prefabs') as PrefabDef[], 'prefabs'),
    spawnTables: table(list('spawnTables') as SpawnTableDef[], 'spawnTables'),
    lootTables: table(list('lootTables') as LootTableDef[], 'lootTables'),
    classes: table(list('classes') as ClassDef[], 'classes'),
    features: table(list('features') as FeatureDef[], 'features'),
    balance: merged.balance.get('core:balance') as BalanceDef,
    expeditionTraits: table(list('expeditionTraits') as ExpeditionTraitDef[], 'expeditionTraits'),
    perks: table(list('perks') as PerkDef[], 'perks'),
    abilities: table(list('abilities') as AbilityDef[], 'abilities'),
    weaponTraits: table(list('weaponTraits') as WeaponTraitDef[], 'weaponTraits'),
    guardianTypes: table(list('guardianTypes') as GuardianTypeDef[], 'guardianTypes'),
    guardianWeaknesses: table(list('guardianWeaknesses') as GuardianWeaknessDef[], 'guardianWeaknesses'),
    guardianNames: table(list('guardianNames') as GuardianNamesDef[], 'guardianNames'),
    boons: table(list('boons') as BoonDef[], 'boons'),
    lore: table(list('lore') as LoreDef[], 'lore'),
    lists: {
      monsters: list('monsters') as MonsterDef[], items: list('items') as ItemDef[], appearances: list('appearances') as AppearanceDef[],
      affixes: list('affixes') as AffixDef[], biomes: list('biomes') as BiomeDef[], floorTypes: list('floorTypes') as FloorTypeDef[],
      prefabs: list('prefabs') as PrefabDef[], classes: list('classes') as ClassDef[], features: list('features') as FeatureDef[],
      expeditionTraits: list('expeditionTraits') as ExpeditionTraitDef[],
      perks: list('perks') as PerkDef[], abilities: list('abilities') as AbilityDef[], weaponTraits: list('weaponTraits') as WeaponTraitDef[],
      guardianTypes: list('guardianTypes') as GuardianTypeDef[], guardianWeaknesses: list('guardianWeaknesses') as GuardianWeaknessDef[],
      boons: list('boons') as BoonDef[],
      lore: list('lore') as LoreDef[],
      relics: (list('items') as ItemDef[]).filter((it) => it.category === 'relic' && !!it.boon),
    },
    deepestDefined: 1,
  };
  c.deepestDefined = Math.max(1, c.balance.monsterTableDepth ?? 1, ...c.lists.monsters.map((m) => m.depth.peak ?? m.depth.min));
  crossValidate(c);
  c.version = canonicalHash({
    terrain: c.terrain, monsters: c.lists.monsters, items: c.lists.items, appearances: c.lists.appearances,
    affixes: c.lists.affixes, statuses: c.statuses, biomes: c.lists.biomes, floorTypes: c.lists.floorTypes,
    prefabs: c.lists.prefabs, spawnTables: c.spawnTables, lootTables: c.lootTables, classes: c.lists.classes, features: c.lists.features,
    balance: c.balance, expeditionTraits: c.lists.expeditionTraits,
    perks: c.lists.perks, abilities: c.lists.abilities, weaponTraits: c.lists.weaponTraits,
    guardianTypes: c.lists.guardianTypes, guardianWeaknesses: c.lists.guardianWeaknesses, guardianNames: c.guardianNames,
    boons: c.lists.boons, lore: c.lists.lore,
  }).slice(0, 12);
  return c;
}

function crossValidate(c: Content): void {
  const errs: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };
  need(!!c.balance, 'balance.json に core:balance が必要');
  if (c.balance) {
    for (const k of ['reach_depth', 'slay_guardian', 'retrieve_relic', 'retrieve_relic_guarded']) need(k in c.balance.expedition.typePct, `balance.expedition.typePct に ${k} が必要`);
    for (const s of Object.values(c.balance.expedition.slots)) need(s.aheadMax >= s.aheadMin, 'balance.expedition.slots: aheadMax >= aheadMin');
    need(c.balance.wander.intervalMax >= c.balance.wander.intervalMin, 'balance.wander: intervalMax >= intervalMin');
  }
  need(!!c.items['core:relic'], '遠征の遺物 core:relic が必要');
  for (const it of c.lists.items) if (it.boon) need(!!c.boons[it.boon], `${it.id}: 未定義の加護 ${it.boon}`);
  need(!!c.items['core:lifeline']?.bound, '帰還の綱 core:lifeline（bound）が必要');
  need(!!c.statuses['core:recall'], '帰還中の状態 core:recall が必要');
  if (c.balance) need(c.balance.guardian.ranks.length >= 3, 'balance.guardian.ranks は格 1〜3 の 3 つが必要');
  for (const it of c.lists.items) if (it.category === 'treasure') need(!!it.value, `${it.id}: 宝には value が必要`);
  need(!!c.lootTables['core:treasure_loot'], '守護者の確定ドロップ core:treasure_loot が必要');
  if (c.balance) for (const k of ['safe', 'standard', 'ambitious']) need(k in c.balance.expedition.slots, `balance.expedition.slots に ${k} が必要`);
  need(c.lists.affixes.some((a) => a.target === 'guardian'), '守護者用の接辞（target: guardian）が必要');
  const t = (id: string, where: string) => need(id in c.terrainIndex, `${where}: 未定義の terrain ${id}`);
  for (const b of c.lists.biomes) {
    t(b.palette.floor, b.id); t(b.palette.wall, b.id); t(b.palette.doorClosed, b.id); t(b.palette.doorOpen, b.id);
    for (const e of b.palette.extra) t(e.terrain, b.id);
    for (const f of b.features) need(!!c.features[f.feature], `${b.id}: 未定義の feature ${f.feature}`);
  }
  for (const m of c.lists.monsters) for (const d of m.drops) need(!!c.lootTables[d.table], `${m.id}: 未定義の lootTable ${d.table}`);
  const glyphs = new Map<string, string>();
  for (const m of c.lists.monsters) {
    const other = glyphs.get(m.glyph);
    need(!other, `${m.id}: 地図の文字 '${m.glyph}' が ${other} と重複`);
    glyphs.set(m.glyph, m.id);
  }
  for (const lt of Object.values(c.lootTables)) {
    for (const e of lt.entries) {
      need(!!e.item !== !!e.category, `${lt.id}: entry は item か category のどちらか一方`);
      if (e.item) need(!!c.items[e.item], `${lt.id}: 未定義の item ${e.item}`);
      if (e.category) need(c.lists.items.some((i) => i.category === e.category), `${lt.id}: category ${e.category} のアイテムが無い`);
    }
  }
  for (const ft of c.lists.floorTypes) {
    need(!!c.spawnTables[ft.monsters.table], `${ft.id}: 未定義の spawnTable ${ft.monsters.table}`);
    need(!!c.lootTables[ft.items.table], `${ft.id}: 未定義の lootTable ${ft.items.table}`);
    for (const g of ft.guaranteedFeatures) need(!!c.features[g], `${ft.id}: 未定義の feature ${g}`);
  }
  for (const p of c.lists.prefabs) {
    const width = Math.max(...p.map.map((r) => r.length));
    need(p.map.every((r) => r.length === width), `${p.id}: map の各行の長さを揃えること`);
    const chars = new Set(p.map.join('').split(''));
    for (const ch of chars) need(ch === ' ' || ch in p.legend, `${p.id}: 凡例に無い文字 '${ch}'`);
    for (const [ch, cell] of Object.entries(p.legend)) {
      if (cell.terrain && !cell.terrain.startsWith('$')) t(cell.terrain, `${p.id}['${ch}']`);
      if (cell.feature) need(!!c.features[cell.feature], `${p.id}: 未定義の feature ${cell.feature}`);
      if (cell.monster && !cell.monster.startsWith('$')) need(!!c.monsters[cell.monster], `${p.id}: 未定義の monster ${cell.monster}`);
      if (cell.item && !cell.item.startsWith('$')) need(!!c.items[cell.item], `${p.id}: 未定義の item ${cell.item}`);
      if (cell.loot) need(!!c.lootTables[cell.loot], `${p.id}: 未定義の lootTable ${cell.loot}`);
    }
  }
  for (const cl of c.lists.classes) for (const si of cl.startItems) need(!!c.items[si.item], `${cl.id}: 未定義の item ${si.item}`);
  // ビルド（V3-4）
  for (const cl of c.lists.classes) for (const pk of cl.startPerks) need(!!c.perks[pk], `${cl.id}: 未定義の perk ${pk}`);
  const lineages = new Set(['common', ...c.lists.classes.flatMap((cl) => cl.lineages.map((l) => l.id))]);
  for (const pk of c.lists.perks) {
    need(lineages.has(pk.lineage), `${pk.id}: 未定義の系統 ${pk.lineage}`);
    if (pk.ability) need(!!c.abilities[pk.ability], `${pk.id}: 未定義の ability ${pk.ability}`);
    for (const r of pk.requires) need(!!c.perks[r], `${pk.id}: 未定義の前提 ${r}`);
  }
  for (const it of c.lists.items) for (const tr of it.equip?.traits ?? []) need(!!c.weaponTraits[tr], `${it.id}: 未定義の weaponTrait ${tr}`);
  for (const s of ['core:stun', 'core:evasive', 'core:braced', 'core:cowed']) need(!!c.statuses[s], `状態 ${s} が必要（V3-4）`);
  for (const it of c.lists.items) {
    if (it.equip?.slot === 'weapon') need(!!it.equip.dmg, `${it.id}: 武器は equip.dmg が必要`);
  }
  // 未鑑定になり得る種別の数以上の外見がカテゴリごとに必要
  const unidentCats = new Map<string, number>();
  for (const it of c.lists.items) if (it.unidentified) unidentCats.set(it.category, (unidentCats.get(it.category) ?? 0) + 1);
  for (const [cat, n] of unidentCats) {
    const apps = c.lists.appearances.filter((a) => a.category === cat).length;
    need(apps >= n, `外見が不足: category ${cat} は ${n} 種が未鑑定になり得るが外見は ${apps} 個`);
  }
  for (const s of ['core:floor', 'core:wall', 'core:stairs_down', 'core:stairs_up']) t(s, 'core');
  if (errs.length) throw new ContentError('コンテンツ検証エラー:\n- ' + errs.join('\n- '));
}

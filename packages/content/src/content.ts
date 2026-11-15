// 検証済みコンテンツの束。ID → 定義の表と、決定的な走査用の ID 順リストを持つ。
import { canonicalHash } from '@muse/shared';
import type {
  AffixDef, AppearanceDef, BiomeDef, ClassDef, FeatureDef, FileKind, FloorTypeDef, ItemDef,
  LootTableDef, MonsterDef, PrefabDef, SpawnTableDef, StatusDef, TerrainDef,
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
  /** 各表の ID 昇順リスト（決定的な走査用） */
  lists: {
    monsters: MonsterDef[]; items: ItemDef[]; appearances: AppearanceDef[]; affixes: AffixDef[];
    biomes: BiomeDef[]; floorTypes: FloorTypeDef[]; prefabs: PrefabDef[]; classes: ClassDef[]; features: FeatureDef[];
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
    lists: {
      monsters: list('monsters') as MonsterDef[], items: list('items') as ItemDef[], appearances: list('appearances') as AppearanceDef[],
      affixes: list('affixes') as AffixDef[], biomes: list('biomes') as BiomeDef[], floorTypes: list('floorTypes') as FloorTypeDef[],
      prefabs: list('prefabs') as PrefabDef[], classes: list('classes') as ClassDef[], features: list('features') as FeatureDef[],
    },
    deepestDefined: 1,
  };
  c.deepestDefined = Math.max(1, ...c.lists.monsters.map((m) => m.depth.peak ?? m.depth.min));
  crossValidate(c);
  c.version = canonicalHash({
    terrain: c.terrain, monsters: c.lists.monsters, items: c.lists.items, appearances: c.lists.appearances,
    affixes: c.lists.affixes, statuses: c.statuses, biomes: c.lists.biomes, floorTypes: c.lists.floorTypes,
    prefabs: c.lists.prefabs, spawnTables: c.spawnTables, lootTables: c.lootTables, classes: c.lists.classes, features: c.lists.features,
  }).slice(0, 12);
  return c;
}

function crossValidate(c: Content): void {
  const errs: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };
  const t = (id: string, where: string) => need(id in c.terrainIndex, `${where}: 未定義の terrain ${id}`);
  for (const b of c.lists.biomes) {
    t(b.palette.floor, b.id); t(b.palette.wall, b.id); t(b.palette.doorClosed, b.id); t(b.palette.doorOpen, b.id);
    for (const e of b.palette.extra) t(e.terrain, b.id);
    for (const f of b.features) need(!!c.features[f.feature], `${b.id}: 未定義の feature ${f.feature}`);
  }
  for (const m of c.lists.monsters) for (const d of m.drops) need(!!c.lootTables[d.table], `${m.id}: 未定義の lootTable ${d.table}`);
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

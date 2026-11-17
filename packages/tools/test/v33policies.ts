// V3-3 の対戦の方針と場面（型ごとに「型を読まない方針」と「型を読む方針」）。テストと計測で共用。
import type { Command, Dir, PlayerView } from '@muse/shared';
import { cheb, DIR_VEC, DIRS } from '@muse/shared';
import type { DuelSpec, Policy } from './v33duel';
import { content, dirTowards, hitAdjacent } from './v33duel';

function passableAt(v: PlayerView, x: number, y: number): boolean {
  const f = v.floor;
  if (!f || x < 0 || y < 0 || x >= f.width || y >= f.height) return false;
  const id = v.terrainTable[v.memory.terrain[y * f.width + x]];
  const t = id ? content.terrain[content.terrainIndex[id]] : undefined;
  return !!t?.passable && !v.entities.some((e) => (e.cat === 'monster' || e.cat === 'player') && e.pos.x === x && e.pos.y === y);
}

const wait: Command = { type: 'wait' };
const naive: Policy = (v, c) => hitAdjacent(v, c.guardianId) ?? wait;

function slotOf(v: PlayerView, kind: string): string | null {
  return v.inventory.find((i) => i.kind === kind)?.slot ?? null;
}

// ---- 突き進む者: 構えを見たら直線から外れる ----
const chargerReader: Policy = (v, c) => {
  const g = v.entities.find((e) => e.id === c.guardianId);
  const me = v.self.pos;
  if (g?.intent?.kind === 'winding_up' && g.intent.dir && me) {
    const dv = DIR_VEC[g.intent.dir];
    let onLine = false;
    for (let k = 1; k <= 6; k++) if (g.pos.x + dv[0] * k === me.x && g.pos.y + dv[1] * k === me.y) onLine = true;
    if (onLine) {
      const opp = DIRS.find((d) => DIR_VEC[d][0] === -dv[0] && DIR_VEC[d][1] === -dv[1]);
      for (const d of DIRS) {
        if (d === g.intent.dir || d === opp) continue;
        const nx = me.x + DIR_VEC[d][0], ny = me.y + DIR_VEC[d][1];
        // 動いた先も同じ直線の上でないこと
        let still = false;
        for (let k = 1; k <= 6; k++) if (g.pos.x + dv[0] * k === nx && g.pos.y + dv[1] * k === ny) still = true;
        if (!still && passableAt(v, nx, ny)) return { type: 'move', dir: d };
      }
    }
  }
  return naive(v, c);
};

// ---- 護られし者: 護りの火を先に消す ----
const wardedReader: Policy = (v, c) => {
  const me = v.self.pos;
  if (me) {
    const fire = v.entities.find((e) => e.cat === 'feature' && e.kind === 'core:ward_fire' && e.state === 'lit' && cheb(e.pos, me) <= 1);
    if (fire) {
      const d = cheb(fire.pos, me) === 0 ? undefined : dirTowards(me, fire.pos) ?? undefined;
      return d ? { type: 'interact', dir: d } : { type: 'interact' };
    }
  }
  return naive(v, c);
};

// ---- 呼び集める者: 手下を先に片付ける ----
const summonerReader: Policy = (v, c) => {
  const me = v.self.pos;
  if (me) {
    const minion = v.entities.filter((e) => e.cat === 'monster' && e.id !== c.guardianId && cheb(e.pos, me) <= 1)[0];
    if (minion) { const d = dirTowards(me, minion.pos); if (d) return { type: 'move', dir: d }; }
  }
  return naive(v, c);
};

// ---- 荒ぶる者: 型を読まなければ、危なくなってから（HP 25% 未満）回復する。
// 読めば、半分まで削る前に準備を終える（相手が軽傷か怒りの予兆のうちに、HP 60% 未満なら回復しておく）。怒った後は一撃が重いので、40% 未満で回復する
function potionPolicy(readIntent: boolean): Policy {
  return (v, c) => {
    const g = v.entities.find((e) => e.id === c.guardianId);
    const hp = v.self.stats.hp, max = v.self.stats.maxHp;
    const heal = slotOf(v, 'core:potion_healing');
    if (heal && hp * 4 < max) return { type: 'use', slot: heal };
    if (readIntent && heal && g) {
      if ((g.hp === 'wounded' || g.intent?.kind === 'enraging') && hp * 10 < max * 6) return { type: 'use', slot: heal };
      if ((g.hp === 'badly_wounded' || g.hp === 'near_death') && hp * 10 < max * 4) return { type: 'use', slot: heal };
    }
    return naive(v, c);
  };
}

// ---- 弾く者: 離れて投げても半分。引き撃ちせず、隣に来させてから投げる ----
function knifeSlot(v: PlayerView): string | null { return slotOf(v, 'core:throwing_knife'); }
function kiter(throwAtRange: boolean): Policy {
  return (v, c) => {
    const g = v.entities.find((e) => e.id === c.guardianId);
    const me = v.self.pos;
    const k = knifeSlot(v);
    if (!g || !me || !k) return naive(v, c);
    if (cheb(g.pos, me) <= 1) {
      const away = DIRS.filter((d) => passableAt(v, me.x + DIR_VEC[d][0], me.y + DIR_VEC[d][1]))
        .sort((a, b) => cheb({ x: me.x + DIR_VEC[b][0], y: me.y + DIR_VEC[b][1] }, g.pos) - cheb({ x: me.x + DIR_VEC[a][0], y: me.y + DIR_VEC[a][1] }, g.pos))[0];
      if (away && cheb({ x: me.x + DIR_VEC[away][0], y: me.y + DIR_VEC[away][1] }, g.pos) > 1) return { type: 'move', dir: away as Dir };
      return { type: 'throw', slot: k, target: g.id };
    }
    // 弾く者を読めば、離れては投げない（半分にされる。ナイフは隣で投げる分に取っておく）
    return throwAtRange && g.shot ? { type: 'throw', slot: k, target: g.id } : wait;
  };
}
// 弾く者を読めば: 離れては投げず、寄って隣で投げる（隣からは半分にならない）
const closeAndThrow: Policy = (v, c) => {
  const g = v.entities.find((e) => e.id === c.guardianId);
  const me = v.self.pos;
  const k = knifeSlot(v);
  if (!g || !me || !k) return naive(v, c);
  if (cheb(g.pos, me) <= 1) return { type: 'throw', slot: k, target: g.id };
  const d = dirTowards(me, g.pos);
  if (d && passableAt(v, me.x + DIR_VEC[d][0], me.y + DIR_VEC[d][1])) return { type: 'move', dir: d };
  return { type: 'travel', to: g.id, mode: 'flee' };
};

export interface Matchup { type: string; naive: { spec: DuelSpec; policy: Policy }; reader: { spec: DuelSpec; policy: Policy } }

const room = (rows: string[]) => rows;

export const MATCHUPS: Matchup[] = [
  {
    type: 'core:charger',
    naive: { spec: { map: room(['P.......G', '.........', '.........']), guardian: { kind: 'core:goblin', hp: 22, dmg: '1d6', acc: 6, might: 1, types: ['core:charger'] }, player: { hp: 22 } }, policy: naive },
    reader: { spec: { map: room(['P.......G', '.........', '.........']), guardian: { kind: 'core:goblin', hp: 22, dmg: '1d6', acc: 6, might: 1, types: ['core:charger'] }, player: { hp: 22 } }, policy: chargerReader },
  },
  {
    type: 'core:warded',
    naive: { spec: { map: room(['.F.....', 'P...G..', '.F.....']), guardian: { kind: 'core:goblin', hp: 24, dmg: '1d4', acc: 4, types: ['core:warded'] }, player: { hp: 24 } }, policy: naive },
    reader: { spec: { map: room(['.F.....', 'P...G..', '.F.....']), guardian: { kind: 'core:goblin', hp: 24, dmg: '1d4', acc: 4, types: ['core:warded'] }, player: { hp: 24 } }, policy: wardedReader },
  },
  {
    type: 'core:summoner',
    // 開けた部屋で本体だけを殴る（型を読まない）と、通路に陣取って隣に来た相手から片付ける（型を読む: 手下に囲まれない）
    naive: { spec: { map: room(['.......', '.......', 'P..G...', '.......', '.......']), guardian: { kind: 'core:goblin', hp: 36, dmg: '1d4', acc: 4, types: ['core:summoner'] }, player: { hp: 26 } }, policy: naive },
    reader: { spec: { map: room(['P.....G']), guardian: { kind: 'core:goblin', hp: 36, dmg: '1d4', acc: 4, types: ['core:summoner'] }, player: { hp: 26 } }, policy: summonerReader },
  },
  {
    type: 'core:enrager',
    naive: { spec: { map: room(['.......', 'P..G...', '.......']), guardian: { kind: 'core:goblin', hp: 44, dmg: '1d6', acc: 6, might: 1, types: ['core:enrager'] }, player: { hp: 24, items: [{ kind: 'core:potion_healing', qty: 2 }] } }, policy: potionPolicy(false) },
    reader: { spec: { map: room(['.......', 'P..G...', '.......']), guardian: { kind: 'core:goblin', hp: 44, dmg: '1d6', acc: 6, might: 1, types: ['core:enrager'] }, player: { hp: 24, items: [{ kind: 'core:potion_healing', qty: 2 }] } }, policy: potionPolicy(true) },
  },
  {
    type: 'core:stalker',
    // 壁の角の脇に立つ（壁の陰の列を伝って寄られる。型を読まない）と、正面からしか来られない一本道（型を読んで通路に陣取る）
    naive: { spec: { map: room(['P#........G', '...........', '...........']), guardian: { kind: 'core:goblin', hp: 28, dmg: '1d8', acc: 6, might: 1, types: ['core:stalker'] }, player: { hp: 26 }, maxActs: 150 }, policy: naive },
    reader: { spec: { map: room(['P..........G']), guardian: { kind: 'core:goblin', hp: 28, dmg: '1d8', acc: 6, might: 1, types: ['core:stalker'] }, player: { hp: 26 }, maxActs: 150 }, policy: naive },
  },
  {
    type: 'core:deflector',
    // 射撃して距離を取る守護者に、離れて投げ続ける（型を読まない: 半分になる）と、寄って隣で投げる（型を読む）
    naive: { spec: { classId: 'core:scout', map: room(['P.......G', '.........', '.........']), guardian: { kind: 'core:goblin_slinger', archetype: 'ranged_kiter', hp: 22, dmg: '1d4', acc: 5, types: ['core:deflector'] }, player: { hp: 22, items: [{ kind: 'core:throwing_knife', qty: 30 }] }, maxActs: 120 }, policy: kiter(true) },
    reader: { spec: { classId: 'core:scout', map: room(['P.......G', '.........', '.........']), guardian: { kind: 'core:goblin_slinger', archetype: 'ranged_kiter', hp: 22, dmg: '1d4', acc: 5, types: ['core:deflector'] }, player: { hp: 22, items: [{ kind: 'core:throwing_knife', qty: 30 }] }, maxActs: 120 }, policy: closeAndThrow },
  },
];

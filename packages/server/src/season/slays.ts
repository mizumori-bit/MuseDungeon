// 討伐の記録（S4。SEASON.md §35.5・PROTOCOL.md §9.13）: 節目の大守護者を倒した参加者の、その戦いの事実を、そのランの出来事の記録から作る。
// 自由な文（thought・プレイヤーの付けた文）は使わない。場所の座標は持たない。未鑑定の品は載せない。
// 装備・レベル・手番・HP の割合は、倒した時点の World（そのランの出来事を、倒した出来事まで applyEvent で畳んだもの）から読む。
import type { Entity, GameEvent, PlayerId, SeasonSlay, SlayGear, SlayHits, World } from '@muse/shared';
import { applyEvent } from '@muse/shared';

/** 記録の事実（だれのものか・選ばれ方を除いた中身） */
export type SlayFacts = Omit<SeasonSlay, 'by' | 'mine' | 'first' | 'least' | 'of'>;

interface Acc {
  melee: SlayHits; thrown: SlayHits; poison: SlayHits; feature: SlayHits; crits: number;
  taken: number; lowestPct: number | null;
  used: Map<string, number>; thrownItems: Map<string, number>; abilities: Map<string, number>; wardFires: number;
}

const newAcc = (): Acc => ({
  melee: { total: 0, n: 0 }, thrown: { total: 0, n: 0 }, poison: { total: 0, n: 0 }, feature: { total: 0, n: 0 }, crits: 0,
  taken: 0, lowestPct: null, used: new Map(), thrownItems: new Map(), abilities: new Map(), wardFires: 0,
});

const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
/** 数の表（多い順、同じなら ID の順。決まった順にする） */
const counts = (m: Map<string, number>): { kind: string; n: number }[] =>
  [...m].map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
const depthOfKey = (key: string | null | undefined): number | null => {
  const m = key ? /^main:(\d+)$/.exec(key) : null;
  return m ? Number(m[1]) : null;
};
const pctOf = (e: Entity | undefined): number | null => {
  const s = e?.stats;
  if (!s || s.maxHp <= 0) return null;
  return Math.max(0, Math.min(100, Math.trunc((Math.max(0, s.hp) * 100) / s.maxHp)));
};

/**
 * そのランで倒した節目の大守護者の記録（倒した順）。skip に入っている深さは作らない（もう載っている）。
 * history: そのランの出来事（番号の順）。base: 畳み始めの World と番号（RunSession.foldBase。境目があれば境目のキーフレームから）。
 * live: 今の World（鑑定の知識は今のものを使う: 載せる時点で倒した者が鑑定済みの品だけ）。
 * 畳む途中で失敗したら（記録と World が合わない）、その後の World に頼る値は今の World から取る
 */
export function buildSlays(history: readonly GameEvent[], base: { world: World; from: number }, pid: PlayerId, live: World, skip: ReadonlySet<number>): SlayFacts[] {
  const kills = history.filter((e): e is Extract<GameEvent, { type: 'warden_slain' }> => e.type === 'warden_slain' && !skip.has(e.depth));
  if (!kills.length) return [];
  const pr = live.players[pid];
  if (!pr) return [];
  const meId = pr.entityId;
  const lastKill = kills[kills.length - 1].seq;
  const wardenOf = new Map(kills.map((k) => [k.id, k.depth]));
  const keyOf = new Map(kills.map((k) => [k.depth, `main:${k.depth}`]));
  const keys = new Set(keyOf.values());
  const w = base.world;
  let folding = true;
  let curNo: number | null = null;
  let floor: string | null = null;
  /** 自分の行動した手番の数（actor_scheduled の after 値。出来事だけで追う） */
  let myTurns = 0;
  let myTurnsCause: number | null = null;
  const startTurns = new Map<number, number>();
  const attempts = new Map<number, Set<number>>();
  const accs = new Map<string, Acc>();
  /** 品を手に入れた方法（いちばん新しいもの）。拾った・置き場から取った。無ければ最初から持っていた */
  const got = new Map<string, { got: 'picked' | 'supply'; depth: number | null }>();
  const out: SlayFacts[] = [];
  const known = new Set(pr.knowledge.identified);
  const identified = (kind: string) => live.secret.appearances[kind] === undefined || known.has(kind);
  /** いま見ている出来事の番号（畳み始めの番号より前は、畳んだ World がまだその時点に来ていないので使わない） */
  let atSeq = 0;
  const me = (): Entity | undefined => (folding && atSeq >= base.from ? w.entities[meId] : undefined);
  const accFor = (depth: number): Acc | null => {
    if (curNo === null) return null;
    const k = `${depth}|${curNo}`;
    let a = accs.get(k);
    if (!a) { a = newAcc(); a.lowestPct = pctOf(me()); accs.set(k, a); }
    return a;
  };
  for (const ev of history) {
    if (ev.seq > lastKill) break;
    atSeq = ev.seq;
    if (folding && ev.seq > base.from) {
      try { applyEvent(w, ev); } catch { folding = false; }
    }
    // 自分のいる階（出来事だけで追う。畳めない区間でも数えられるように）
    if (ev.type === 'player_joined' && ev.player.id === pid) floor = ev.entity.pos?.floor ?? null;
    else if (ev.type === 'entity_changed_floor' && ev.id === meId) floor = ev.to.floor;
    else if (ev.type === 'player_state' && ev.player === pid) {
      const body = ev.put?.find((e) => e.id === meId);
      if (ev.state === 'at_camp' || ev.state === 'dead' || ev.state === 'left') floor = null;
      else if (body?.pos) floor = body.pos.floor;
    }
    if (ev.type === 'actor_scheduled' && ev.id === meId) { myTurns = ev.turns; myTurnsCause = ev.cause; }
    if (ev.type === 'expedition_started') {
      curNo = ev.expedition.no;
      startTurns.set(curNo, myTurns);
    } else if (ev.type === 'expedition_ended') curNo = null;
    // 品を手に入れた（拾った・置き場から取った）
    if (ev.type === 'item_picked_up' && ev.actor === meId) got.set(ev.item, { got: 'picked', depth: depthOfKey(ev.floor) });
    else if (ev.type === 'supply_taken' && ev.player === pid) for (const e of ev.put ?? []) if (e.item && e.id !== meId) got.set(e.id, { got: 'supply', depth: ev.depth });
    // その階に入った遠征（挑んだ回数）
    if (floor && keys.has(floor) && curNo !== null) {
      const d = depthOfKey(floor)!;
      const s = attempts.get(d) ?? new Set<number>();
      s.add(curNo);
      attempts.set(d, s);
      accFor(d);
    }
    const evDepth = depthOfKey(ev.floor);
    const acc = evDepth !== null && keys.has(ev.floor!) && floor === ev.floor ? accFor(evDepth) : null;
    if (acc) {
      if (ev.type === 'damaged') {
        const amount = ev.dealt ?? ev.amount;
        if (wardenOf.has(ev.target)) {
          if (ev.via === 'melee' && ev.source === meId) { acc.melee.total += amount; acc.melee.n++; }
          else if (ev.via === 'thrown' && ev.source === meId) { acc.thrown.total += amount; acc.thrown.n++; }
          else if (ev.via === 'poison' && amount > 0) { acc.poison.total += amount; acc.poison.n++; }
          else if ((ev.via === 'effect' || ev.via === 'trap' || ev.via === 'other') && ev.source !== meId && amount > 0) { acc.feature.total += amount; acc.feature.n++; }
        }
        if (ev.target === meId) acc.taken += amount;
      } else if (ev.type === 'attack' && ev.attacker === meId && ev.target && wardenOf.has(ev.target) && ev.hit && ev.crit) acc.crits++;
      else if (ev.type === 'item_used' && ev.actor === meId && ev.kind && ev.category !== 'lifeline' && ev.category !== 'key' && identified(ev.kind)) add(acc.used, ev.kind);
      else if (ev.type === 'item_thrown' && ev.actor === meId && ev.kind && identified(ev.kind)) add(acc.thrownItems, ev.kind);
      else if (ev.type === 'ability_used' && ev.actor === meId) add(acc.abilities, ev.ability);
      else if (ev.type === 'feature_state' && ev.kind === 'core:ward_fire' && ev.state === 'out') acc.wardFires++;
      // いちばん低かった HP の割合（自分の HP が動いた出来事の後の World で）
      if ((ev.type === 'damaged' || ev.type === 'healed' || ev.type === 'max_hp_changed' || ev.type === 'level_up') && ev.target === meId) {
        const p = pctOf(me());
        if (p !== null) acc.lowestPct = acc.lowestPct === null ? p : Math.min(acc.lowestPct, p);
      }
    }
    if (ev.type === 'warden_slain' && !skip.has(ev.depth) && !out.some((x) => x.depth === ev.depth)) {
      const a = curNo !== null ? accs.get(`${ev.depth}|${curNo}`) ?? newAcc() : newAcc();
      const body = me() ?? live.entities[meId];
      const world = me() ? w : live;
      let hidden = false;
      const gear = (slot: 'weapon' | 'armor'): SlayGear | null => {
        const id = body?.equip?.[slot];
        const it = id ? world.entities[id] : undefined;
        if (!it?.item) return null;
        if (!identified(it.kind)) { hidden = true; return null; }
        const g = got.get(it.id);
        return { kind: it.kind, affixes: [...(it.item.affixes ?? [])], ...(g ? { got: g.got, ...(g.depth !== null ? { depth: g.depth } : {}) } : { got: 'start' as const }) };
      };
      const weapon = gear('weapon');
      const armor = gear('armor');
      out.push({
        depth: ev.depth, warden: { ja: ev.guardianName.ja, en: ev.guardianName.en },
        level: body?.level?.level ?? 1, classId: live.players[pid].classId,
        weapon, armor, ...(hidden ? { hidden: true } : {}),
        dealt: { melee: { ...a.melee }, thrown: { ...a.thrown }, poison: { ...a.poison }, feature: { ...a.feature }, crits: a.crits },
        taken: a.taken, lowestPct: a.lowestPct ?? pctOf(body) ?? 100,
        used: counts(a.used), thrown: counts(a.thrownItems), abilities: counts(a.abilities).map((x) => ({ id: x.kind, n: x.n })),
        wardFires: a.wardFires,
        attempt: Math.max(1, attempts.get(ev.depth)?.size ?? 1),
        // 倒した手番を含む: 自分の一手で倒した（同じ命令の中で、自分の手番の終わりがまだ来ていない）なら、その一手の分を足す
        turns: curNo !== null ? Math.max(0, myTurns + (myTurnsCause === ev.cause ? 0 : 1) - (startTurns.get(curNo) ?? myTurns)) : 0,
      });
    }
  }
  return out;
}

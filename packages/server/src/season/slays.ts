// 討伐の記録（S4。SEASON.md §35.5・PROTOCOL.md §9.13）: 節目の大守護者を倒した参加者の、その戦いの事実を、そのランの出来事の記録から作る。
// 自由な文（thought・プレイヤーの付けた文）は使わない。場所の座標は持たない。未鑑定の品は載せない。
// 装備・レベル・手番・HP の割合は、倒した時点の World（そのランの出来事を、倒した出来事まで applyEvent で畳んだもの）から読む。
// S5（SEASON.md §47.4）: 予備動作への対し方と、相手が動けなかった手番も数える。倒さずに帰った自分の挑戦（buildAttempts）も、同じ数え方で作る。
import type { Entity, GameEvent, Intent, Names, PlayerId, SeasonSlayFacts, SlayGear, SlayHits, SlayOpening, SlayOpenings, SlayTell, World } from '@muse/shared';
import { actorSeen, applyEvent } from '@muse/shared';

/** 記録の事実（だれのものか・選ばれ方を除いた中身） */
export type SlayFacts = SeasonSlayFacts;

/** 動けなくする状態の ID（コンテンツの状態のうち handler が incapacitate のもの: 朦朧・睡眠） */
export function incapStatuses(content: { statuses: Record<string, { id: string; handler: string }> }): Set<string> {
  return new Set(Object.values(content.statuses).filter((s) => s.handler === 'incapacitate').map((s) => s.id));
}

interface Acc {
  melee: SlayHits; thrown: SlayHits; poison: SlayHits; feature: SlayHits; crits: number;
  taken: number; lowestPct: number | null;
  used: Map<string, number>; thrownItems: Map<string, number>; abilities: Map<string, number>; wardFires: number;
  /** 予備動作（種類ごと。最初に構えた順） */
  tells: Map<string, SlayTell>;
  openings: SlayOpenings;
}

const newAcc = (): Acc => ({
  melee: { total: 0, n: 0 }, thrown: { total: 0, n: 0 }, poison: { total: 0, n: 0 }, feature: { total: 0, n: 0 }, crits: 0,
  taken: 0, lowestPct: null, used: new Map(), thrownItems: new Map(), abilities: new Map(), wardFires: 0,
  tells: new Map(), openings: { missed: newOpening(), other: newOpening() },
});
function newOpening(): SlayOpening { return { turns: 0, dealt: 0, hitTurns: 0, taken: 0 }; }

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
/** 突進・大振り: 外れると動けなくなり、当たれば相手に届く予備動作 */
const STRIKES: ReadonlySet<string> = new Set<Intent['kind']>(['winding_up', 'swinging']);

/** 大守護者 1 体の、出来事から追う状態（状態異常・眠り・予備動作） */
interface WardenTrack {
  depth: number;
  statuses: Set<string>;
  asleep: boolean;
  /** いま構えている予備動作（無ければ null） */
  intent: string | null;
  /** その予備動作を数えた所（構えたとき、自分がその階の遠征にいた）と、もう見えていたか */
  tell: SlayTell | null;
  seen: boolean;
  /** 構えを解いて、大きな一撃を出しているところ（同じ手番の中で外れか当たりが決まる） */
  resolving: SlayTell | null;
  /** いまの動けない状態は、予備動作を外させたもの */
  missStun: boolean;
}

/** 自分の手番 1 つ（相手が動けなかった手番）の数えかけ。o: 数える所（外させた後か、それ以外か）。閉じるときに、戦いが始まっていれば数える（S5a） */
interface Win { wid: string; o: SlayOpening; action: boolean; dealt: number; taken: number }

/** 載せる時点の装備・レベル・手番 */
interface Snap { level: number; classId: string; weapon: SlayGear | null; armor: SlayGear | null; hidden: boolean; turns: number }

/**
 * そのランの出来事を順に読んで、大守護者との戦いを数える（倒した記録と、倒さずに帰った挑戦の両方で同じ）。
 * 数は出来事だけで数える。HP の割合・装備・見えていたかは、畳んだ World から読む（畳めない区間では、HP の割合は数えず、見えていたことにする）
 */
class FightScan {
  private readonly w: World;
  private folding = true;
  private atSeq = 0;
  curNo: number | null = null;
  private floor: string | null = null;
  /** 自分の行動した手番の数（actor_scheduled の after 値。出来事だけで追う）と、自分の手番の中（turn_began の後、actor_scheduled の前）か */
  private myTurns = 0;
  private inMyTurn = false;
  private readonly startTurns = new Map<number, number>();
  /** 深さごとの、大守護者と戦った（攻撃・被害の出来事があった）遠征の番号 */
  readonly attempts = new Map<number, Set<number>>();
  private readonly accs = new Map<string, Acc>();
  /** 品を手に入れた方法（いちばん新しいもの）。拾った・置き場から取った。無ければ最初から持っていた */
  private readonly got = new Map<string, { got: 'picked' | 'supply'; depth: number | null }>();
  private readonly known: Set<string>;
  private readonly meId: string;
  private readonly keys: Set<string>;
  private readonly tracks = new Map<string, WardenTrack>();
  private wins: Win[] = [];
  /** この遠征で、攻撃・被害の出来事があった大守護者（戦いが始まった。S5a §48.9 の 2: それより前の手番は、動けなかった手番に数えない） */
  private readonly engaged = new Set<string>();
  /** その遠征で、その大守護者と最後に戦った時点の装備など（倒さずに帰った挑戦に使う） */
  readonly lastFight = new Map<string, { no: number; snap: Snap }>();

  constructor(private readonly base: { world: World; from: number }, private readonly pid: PlayerId, private readonly live: World,
    private readonly wardens: ReadonlyMap<string, number>, private readonly incap: ReadonlySet<string>) {
    this.w = base.world;
    const pr = live.players[pid];
    this.meId = pr.entityId;
    this.known = new Set(pr.knowledge.identified);
    this.keys = new Set([...wardens.values()].map((d) => `main:${d}`));
    for (const [id, depth] of wardens) {
      const e = base.world.entities[id];
      this.tracks.set(id, {
        depth, statuses: new Set((e?.statuses ?? []).map((s) => s.id)), asleep: e?.actor?.ai?.state === 'asleep', intent: e?.actor?.ai?.intent?.kind ?? null,
        tell: null, seen: false, resolving: null, missStun: false,
      });
    }
  }

  private identified(kind: string): boolean { return this.live.secret.appearances[kind] === undefined || this.known.has(kind); }
  /** いま見ている出来事の番号（畳み始めの番号より前は、畳んだ World がまだその時点に来ていないので使わない） */
  private me(): Entity | undefined { return this.folding && this.atSeq >= this.base.from ? this.w.entities[this.meId] : undefined; }
  private accFor(depth: number): Acc | null {
    if (this.curNo === null) return null;
    const k = `${depth}|${this.curNo}`;
    let a = this.accs.get(k);
    if (!a) { a = newAcc(); a.lowestPct = pctOf(this.me()); this.accs.set(k, a); }
    return a;
  }
  acc(depth: number, no: number): Acc | undefined { return this.accs.get(`${depth}|${no}`); }
  /** 自分が、その大守護者の階で遠征をしているときの数えかけ */
  private accHere(depth: number): Acc | null { return this.floor === `main:${depth}` && this.curNo !== null ? this.accFor(depth) : null; }

  /** 大守護者が自分から見えるか（畳んだ World の視界と、草の中か。畳めないときは見えていたことにする） */
  private sees(wid: string): boolean {
    if (!this.me()) return true;
    const w = this.w;
    const meE = w.entities[this.meId];
    const wE = w.entities[wid];
    if (!meE?.pos || !wE?.pos || meE.pos.floor !== wE.pos.floor) return false;
    const f = w.floors[wE.pos.floor];
    const vis = w.players[this.pid]?.knowledge?.visible;
    if (!f || !vis) return true;
    return actorSeen(w, wE.pos.floor, wE.pos, meE.pos, vis.includes(wE.pos.y * f.width + wE.pos.x));
  }

  /**
   * 数えかけの手番を閉じる（次の自分の手番・階を離れた・遠征が終わった・倒した）。その手番の終わりまでに戦いが始まっていなければ数えない
   * （眠っている相手を見ていただけの手番。戦いを始めた一手の手番は数える）
   */
  private closeWins(wid?: string): void {
    const keep: Win[] = [];
    for (const x of this.wins) {
      if (wid !== undefined && x.wid !== wid) { keep.push(x); continue; }
      if (!this.engaged.has(x.wid)) continue;
      x.o.turns++;
      x.o.dealt += x.dealt;
      x.o.taken += x.taken;
      if (x.dealt > 0) x.o.hitTurns++;
    }
    this.wins = keep;
  }

  /** 大守護者の状態の更新（状態異常・眠り・予備動作）。出来事の after 値から */
  private updateTrack(wid: string, p: { statuses?: readonly { id: string }[]; state?: string; intent?: Intent | null }): void {
    const t = this.tracks.get(wid);
    if (!t) return;
    if (p.statuses) {
      t.statuses = new Set(p.statuses.map((s) => s.id));
      if (![...t.statuses].some((s) => this.incap.has(s))) t.missStun = false;
    }
    if (p.state !== undefined) t.asleep = p.state === 'asleep';
    if (p.intent !== undefined) {
      const k = p.intent?.kind ?? null;
      if (k && k !== t.intent) {
        // 新しく構えた: 自分がその階の遠征にいれば数える
        const acc = this.accHere(t.depth);
        let rec: SlayTell | null = null;
        if (acc) {
          rec = acc.tells.get(k) ?? { kind: k as Intent['kind'], n: 0, seen: 0, missed: 0, hit: 0 };
          rec.n++;
          acc.tells.set(k, rec);
          // 構えたら戦いが始まった（突進が空を切ると、攻撃の出来事は出ない。S5a）
          this.engaged.add(wid);
        }
        t.intent = k; t.tell = rec; t.seen = false; t.resolving = null;
      } else if (!k && t.intent) {
        // 構えを解いた: 突進・大振りなら、同じ手番の中で外れか当たりが決まる
        t.resolving = STRIKES.has(t.intent) ? t.tell : null;
        t.intent = null; t.tell = null; t.seen = false;
      }
    }
  }

  private snap(): Snap {
    const body = this.me() ?? this.live.entities[this.meId];
    const world = this.me() ? this.w : this.live;
    let hidden = false;
    const gear = (slot: 'weapon' | 'armor'): SlayGear | null => {
      const id = body?.equip?.[slot];
      const it = id ? world.entities[id] : undefined;
      if (!it?.item) return null;
      if (!this.identified(it.kind)) { hidden = true; return null; }
      const g = this.got.get(it.id);
      return { kind: it.kind, affixes: [...(it.item.affixes ?? [])], ...(g ? { got: g.got, ...(g.depth !== null ? { depth: g.depth } : {}) } : { got: 'start' as const }) };
    };
    const weapon = gear('weapon');
    const armor = gear('armor');
    // その手番を含む: 自分の手番の中（自分の一手で倒した・殴った。手番の終わりがまだ来ていない）なら、その一手の分を足す。
    // S5: 手番の中かは turn_began と actor_scheduled で見る（S4 は命令の番号で見ていて、マクロの 2 手目より後の一手を数え落としていた）
    const turns = this.curNo !== null ? Math.max(0, this.myTurns + (this.inMyTurn ? 1 : 0) - (this.startTurns.get(this.curNo) ?? this.myTurns)) : 0;
    return { level: body?.level?.level ?? 1, classId: this.live.players[this.pid].classId, weapon, armor, hidden, turns };
  }

  /** 1 つの出来事を読む */
  step(ev: GameEvent): void {
    this.atSeq = ev.seq;
    if (this.folding && ev.seq > this.base.from) {
      try { applyEvent(this.w, ev); } catch { this.folding = false; }
    }
    const meId = this.meId;
    const pid = this.pid;
    // 自分のいる階（出来事だけで追う。畳めない区間でも数えられるように）
    const was = this.floor;
    if (ev.type === 'player_joined' && ev.player.id === pid) this.floor = ev.entity.pos?.floor ?? null;
    else if (ev.type === 'entity_changed_floor' && ev.id === meId) this.floor = ev.to.floor;
    else if (ev.type === 'player_state' && ev.player === pid) {
      const body = ev.put?.find((e) => e.id === meId);
      if (ev.state === 'at_camp' || ev.state === 'dead' || ev.state === 'left') this.floor = null;
      else if (body?.pos) this.floor = body.pos.floor;
    }
    if (this.floor !== was) this.closeWins();
    if (ev.type === 'actor_scheduled' && ev.id === meId) {
      this.myTurns = ev.turns; this.inMyTurn = false;
      for (const x of this.wins) x.action = false;
    }
    if (ev.type === 'turn_began' && ev.actor === meId) this.inMyTurn = true;
    if (ev.type === 'expedition_started') {
      this.curNo = ev.expedition.no;
      this.startTurns.set(this.curNo, this.myTurns);
      this.engaged.clear();
    } else if (ev.type === 'expedition_ended') { this.closeWins(); this.curNo = null; }
    // 品を手に入れた（拾った・置き場から取った）
    if (ev.type === 'item_picked_up' && ev.actor === meId) this.got.set(ev.item, { got: 'picked', depth: depthOfKey(ev.floor) });
    else if (ev.type === 'supply_taken' && ev.player === pid) for (const e of ev.put ?? []) if (e.item && e.id !== meId) this.got.set(e.id, { got: 'supply', depth: ev.depth });
    // その階にいる間の数え始め
    if (this.floor && this.keys.has(this.floor) && this.curNo !== null) this.accFor(depthOfKey(this.floor)!);

    // 大守護者の状態（予備動作の結果は、状態を書き換える前に見る）
    this.watchWardens(ev);

    // 挑んだ回数（S4b §46.4 の 1）: 大守護者を的・攻撃者・被害の元とする出来事が 1 つでもあった遠征だけ（階に入っただけの遠征は数えない）
    if (this.curNo !== null) {
      const ids = ev.type === 'attack' ? [ev.attacker, ev.target] : ev.type === 'damaged' ? [ev.target, ev.source] : ev.type === 'warden_slain' ? [ev.id] : [];
      for (const id of ids) {
        const d = id ? this.wardens.get(id) : undefined;
        if (d === undefined) continue;
        const s = this.attempts.get(d) ?? new Set<number>();
        s.add(this.curNo);
        this.attempts.set(d, s);
        this.engaged.add(id!);
        if (ev.type !== 'warden_slain' && this.floor === `main:${d}`) this.lastFight.set(id!, { no: this.curNo, snap: this.snap() });
      }
    }
    const evDepth = depthOfKey(ev.floor);
    const acc = evDepth !== null && this.keys.has(ev.floor!) && this.floor === ev.floor ? this.accFor(evDepth) : null;
    if (acc) {
      if (ev.type === 'damaged') {
        const amount = ev.dealt ?? ev.amount;
        if (this.wardens.has(ev.target)) {
          if (ev.via === 'melee' && ev.source === meId) { acc.melee.total += amount; acc.melee.n++; }
          else if (ev.via === 'thrown' && ev.source === meId) { acc.thrown.total += amount; acc.thrown.n++; }
          else if (ev.via === 'poison' && amount > 0) { acc.poison.total += amount; acc.poison.n++; }
          else if ((ev.via === 'effect' || ev.via === 'trap' || ev.via === 'other') && ev.source !== meId && amount > 0) { acc.feature.total += amount; acc.feature.n++; }
        }
        if (ev.target === meId) acc.taken += amount;
      } else if (ev.type === 'attack' && ev.attacker === meId && ev.target && this.wardens.has(ev.target) && ev.hit && ev.crit) acc.crits++;
      else if (ev.type === 'item_used' && ev.actor === meId && ev.kind && ev.category !== 'lifeline' && ev.category !== 'key' && this.identified(ev.kind)) add(acc.used, ev.kind);
      else if (ev.type === 'item_thrown' && ev.actor === meId && ev.kind && this.identified(ev.kind)) add(acc.thrownItems, ev.kind);
      else if (ev.type === 'ability_used' && ev.actor === meId) add(acc.abilities, ev.ability);
      else if (ev.type === 'feature_state' && ev.kind === 'core:ward_fire' && ev.state === 'out') acc.wardFires++;
      // いちばん低かった HP の割合（自分の HP が動いた出来事の後の World で）
      if ((ev.type === 'damaged' || ev.type === 'healed' || ev.type === 'max_hp_changed' || ev.type === 'level_up') && ev.target === meId) {
        const p = pctOf(this.me());
        if (p !== null) acc.lowestPct = acc.lowestPct === null ? p : Math.min(acc.lowestPct, p);
      }
    }
    // 相手が動けなかった手番の、与えた・受けた被害
    if (ev.type === 'damaged') {
      const amount = ev.dealt ?? ev.amount;
      for (const x of this.wins) {
        if (ev.target === x.wid && x.action && amount > 0) x.dealt += amount;
        if (ev.target === meId) x.taken += amount;
      }
    }
    // 自分の手番の初め: 見えている構えを「見た」に、相手が動けなければ、その手番を数え始める
    if (ev.type === 'turn_began' && ev.actor === meId) {
      this.closeWins();
      for (const [wid, t] of this.tracks) {
        const a = this.accHere(t.depth);
        if (!a) continue;
        const visible = this.sees(wid);
        if (t.intent && t.tell && !t.seen && visible) { t.tell.seen++; t.seen = true; }
        const helpless = t.asleep || [...t.statuses].some((s) => this.incap.has(s));
        if (helpless && visible) {
          const o = t.missStun ? a.openings.missed : a.openings.other;
          this.wins.push({ wid, o, action: true, dealt: 0, taken: 0 });
        }
      }
    }
    if (ev.type === 'warden_slain') this.closeWins(ev.id);
  }

  /** 大守護者の状態を出来事から追う。予備動作の外れ・当たりも、ここで数える */
  private watchWardens(ev: GameEvent): void {
    // 大きな一撃の結果（構えを解いた同じ手番の中）
    for (const [wid, t] of this.tracks) {
      if (!t.resolving) continue;
      if (ev.type === 'attack' && ev.attacker === wid) { if (ev.target === this.meId) t.resolving.hit++; t.resolving = null; }
      else if (ev.type === 'status_applied' && ev.target === wid && this.incap.has(ev.status.id)) { t.resolving.missed++; t.resolving = null; t.missStun = true; }
      else if (ev.type === 'actor_scheduled' && ev.id === wid) t.resolving = null;
    }
    // 動けない状態が残っている間は、外させた朦朧に重なった状態（強打の朦朧など）でも、外させた後の手番のまま
    if (ev.type === 'ai_state_changed' && this.tracks.has(ev.id)) this.updateTrack(ev.id, { state: ev.ai.state, intent: ev.ai.intent ?? null });
    else if (ev.type === 'monster_woke' && this.tracks.has(ev.id)) this.updateTrack(ev.id, { state: 'unaware' });
    else if ((ev.type === 'status_applied' || ev.type === 'status_expired' || ev.type === 'status_ticked') && this.tracks.has(ev.target)) this.updateTrack(ev.target, { statuses: ev.statusesAfter });
    for (const e of [...(ev.type === 'entity_spawned' ? [ev.entity] : []), ...(ev.put ?? [])]) {
      if (!this.tracks.has(e.id)) continue;
      const ai = e.actor?.ai;
      this.updateTrack(e.id, { statuses: e.statuses ?? [], ...(ai ? { state: ai.state, intent: ai.intent ?? null } : {}) });
    }
  }

  /** 1 件の事実（acc はその遠征のその階の数え） */
  facts(depth: number, warden: { ja: string; en: string }, a: Acc | undefined, snap: Snap): SlayFacts {
    const x = a ?? newAcc();
    return {
      depth, warden: { ja: warden.ja, en: warden.en },
      level: snap.level, classId: snap.classId,
      weapon: snap.weapon, armor: snap.armor, ...(snap.hidden ? { hidden: true } : {}),
      dealt: { melee: { ...x.melee }, thrown: { ...x.thrown }, poison: { ...x.poison }, feature: { ...x.feature }, crits: x.crits },
      // いちばん低かった HP の割合: 畳めない区間しか無く分からないときは、項目を省く（S4b §46.4 の 4。載せる時点の HP で代えない）
      taken: x.taken, ...(x.lowestPct !== null ? { lowestPct: x.lowestPct } : {}),
      used: counts(x.used), thrown: counts(x.thrownItems), abilities: counts(x.abilities).map((c) => ({ id: c.kind, n: c.n })),
      wardFires: x.wardFires,
      attempt: Math.max(1, this.attempts.get(depth)?.size ?? 1),
      turns: snap.turns,
      tells: [...x.tells.values()].map((t) => ({ ...t })),
      openings: { missed: { ...x.openings.missed }, other: { ...x.openings.other } },
    };
  }

  /** 倒した時点の記録 */
  killFacts(ev: Extract<GameEvent, { type: 'warden_slain' }>): SlayFacts {
    const a = this.curNo !== null ? this.acc(ev.depth, this.curNo) : undefined;
    return this.facts(ev.depth, ev.guardianName, a, this.snap());
  }
}

/**
 * そのランで倒した節目の大守護者の記録（倒した順）。skip に入っている深さは作らない（もう載っている）。
 * history: そのランの出来事（番号の順）。base: 畳み始めの World と番号（RunSession.foldBase。境目があれば境目のキーフレームから）。
 * live: 今の World（鑑定の知識は今のものを使う: 載せる時点で倒した者が鑑定済みの品だけ）。incap: 動けなくする状態（incapStatuses）。
 * 畳む途中で失敗したら（記録と World が合わない）、その後の World に頼る値は今の World から取る
 */
export function buildSlays(history: readonly GameEvent[], base: { world: World; from: number }, pid: PlayerId, live: World, skip: ReadonlySet<number>, incap: ReadonlySet<string> = new Set()): SlayFacts[] {
  const kills = history.filter((e): e is Extract<GameEvent, { type: 'warden_slain' }> => e.type === 'warden_slain' && !skip.has(e.depth));
  if (!kills.length) return [];
  if (!live.players[pid]) return [];
  const lastKill = kills[kills.length - 1].seq;
  const sc = new FightScan(base, pid, live, new Map(kills.map((k) => [k.id, k.depth])), incap);
  const out: SlayFacts[] = [];
  for (const ev of history) {
    if (ev.seq > lastKill) break;
    sc.step(ev);
    if (ev.type === 'warden_slain' && !skip.has(ev.depth) && !out.some((x) => x.depth === ev.depth)) out.push(sc.killFacts(ev));
  }
  return out;
}

/** その出来事の記録と今の World に出てくる、節目の大守護者の ID と、深さ・呼び名（倒れた個体は warden_slain から） */
export function wardensOf(history: readonly GameEvent[], live: World): Map<string, { depth: number; name: Names }> {
  const out = new Map<string, { depth: number; name: Names }>();
  const note = (e: Entity | undefined) => {
    const d = e?.guardian?.warden ? depthOfKey(e.pos?.floor) : null;
    if (e?.guardian && d !== null) out.set(e.id, { depth: d, name: { ...e.guardian.name } });
  };
  for (const ev of history) {
    if (ev.type === 'entity_spawned') note(ev.entity);
    for (const e of ev.put ?? []) note(e);
    if (ev.type === 'warden_slain' && ev.id) out.set(ev.id, { depth: ev.depth, name: { ...ev.guardianName } });
  }
  for (const e of Object.values(live.entities)) note(e);
  return out;
}

/**
 * 倒さずに帰った自分の挑戦（S5。SEASON.md §47.4 の 2）: 遠征 no で、節目の大守護者と戦った（攻撃・被害の出来事があった）のに、
 * その遠征の終わりまでに倒れなかった大守護者ごとに、討伐の記録と同じ作り方の事実。手番・装備は、その遠征で最後に戦った時点。
 * 共有しない（そのプレイヤーのキャンプの観測にだけ出す）。遠征 no がまだ終わっていなければ空
 */
export function buildAttempts(history: readonly GameEvent[], base: { world: World; from: number }, pid: PlayerId, live: World, no: number, incap: ReadonlySet<string> = new Set()): SlayFacts[] {
  if (!live.players[pid]) return [];
  const wardens = wardensOf(history, live);
  if (!wardens.size) return [];
  const sc = new FightScan(base, pid, live, new Map([...wardens].map(([id, x]) => [id, x.depth])), incap);
  const slain = new Set<string>();
  let ended = false;
  for (const ev of history) {
    sc.step(ev);
    if (ev.type === 'warden_slain') slain.add(ev.id);
    if (ev.type === 'expedition_ended' && ev.no === no) { ended = true; break; }
  }
  if (!ended) return [];
  const out: SlayFacts[] = [];
  for (const [wid, f] of sc.lastFight) {
    if (f.no !== no || slain.has(wid)) continue;
    const x = wardens.get(wid)!;
    out.push(sc.facts(x.depth, x.name, sc.acc(x.depth, no), f.snap));
  }
  return out.sort((a, b) => a.depth - b.depth);
}

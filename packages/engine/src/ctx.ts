// 1 回の step の実行文脈。イベントを発行 → 即 applyEvent を繰り返す。
// World を書き換えるのは applyEvent だけ（ここでも直接代入はしない）。
import type { Content, TerrainDef } from '@muse/content';
import type {
  Entity, EntityId, EventDraft, FloorKey, GameEvent, Locale, PlayerId, PlayerRecord, Pos, World,
} from '@muse/shared';
import { actorSeen, applyEvent, opaqueId, Rng } from '@muse/shared';

export class Ctx {
  readonly events: GameEvent[] = [];
  private readonly rngs = new Map<string, Rng>();
  private visCache = new Map<PlayerId, Set<number>>();
  /** フロアごとの地形変更回数（FOV キャッシュ用） */
  readonly terrainVer = new Map<FloorKey, number>();
  /** 現在行動中のアクターの時刻（イベントの ft 既定値） */
  now = 0;
  curFloor: FloorKey | null = null;
  /** FOV キャッシュ: playerId → key */
  readonly fovCache = new Map<PlayerId, { key: string; cells: number[] }>();
  /** step 内でのみ有効な計算キャッシュ（距離マップなど） */
  readonly scratch = new Map<string, unknown>();
  /** step の中で見ていた敵の行動の回数（プレイヤー → 敵 → 回数。V3-8 §53.4） */
  readonly actsSeen = new Map<PlayerId, Map<string, number>>();
  /** フロアごとのエンティティ一覧（sid 順）。エンティティの増減・置換で無効化 */
  private floorEnts = new Map<FloorKey, Entity[]>();
  /** この step で、自分で出した命令で行動するプレイヤーのエンティティ（V4-1j §30.6。時間切れ・サーバーが代わりに出した命令なら null） */
  selfActor: EntityId | null = null;

  constructor(
    readonly world: World,
    readonly content: Content,
    readonly cause: number | null,
    readonly wall: number,
  ) {}

  rng(stream: 'runtime' | 'ids'): Rng {
    let r = this.rngs.get(stream);
    if (!r) {
      const st = this.world.secret.rng[stream];
      if (!st) throw new Error(`rng stream not initialized: ${stream}`);
      r = new Rng(st);
      this.rngs.set(stream, r);
    }
    return r;
  }

  emit<D extends EventDraft>(d0: D): GameEvent {
    // 自分で出した命令で行動した（手番数が増えた）: actor_scheduled に acted を付ける（V4-1j §30.6。仲間の party[].last_act）
    let draft = d0;
    if (this.selfActor && d0.type === 'actor_scheduled') {
      const a = d0 as unknown as { id: EntityId; turns: number };
      if (a.id === this.selfActor && a.turns > (this.world.entities[a.id]?.actor?.turns ?? 0)) draft = { ...d0, acted: true };
    }
    const floor = draft.floor !== undefined ? draft.floor : this.curFloor;
    const ft = draft.ft !== undefined ? draft.ft : this.now;
    const ev = { ...draft, seq: this.world.seq + 1, cause: this.cause, wall: this.wall, floor, ft } as unknown as GameEvent;
    applyEvent(this.world, ev);
    this.events.push(ev);
    if (ev.type === 'knowledge_updated' && (ev as any).visible) this.visCache.delete((ev as any).player);
    if (ev.type === 'tile_changed') this.terrainVer.set(ev.floor!, (this.terrainVer.get(ev.floor!) ?? 0) + 1);
    // 階の作り直し（V4-0a §1.1）: 同じ鍵の階が別の地形になる
    if (ev.type === 'floor_reset') { this.terrainVer.set(ev.floorKey, (this.terrainVer.get(ev.floorKey) ?? 0) + 1); this.visCache.clear(); this.fovCache.clear(); this.scratch.clear(); }
    if (ev.type === 'entity_changed_floor' || ev.type === 'player_joined') this.visCache.clear();
    if (ev.put || ev.del || ev.type === 'entity_spawned' || ev.type === 'entity_removed' || ev.type === 'entity_changed_floor' || ev.type === 'player_joined' || ev.type === 'floor_generated' || ev.type === 'floor_reset') this.floorEnts.clear();
    return ev;
  }

  /**
   * 番号を指定して出す（S3f の seq_resumed だけが使う: 食い違ったランの続きの番号を、記録の最後の次へ送る）。
   * 番号は今の World の番号より大きいこと。applyEvent が World の番号をその値にする
   */
  emitAt<D extends EventDraft>(seq: number, d: D): GameEvent {
    if (!Number.isInteger(seq) || seq <= this.world.seq) throw new Error(`emitAt: seq ${seq} is not after ${this.world.seq}`);
    const ev = { ...d, seq, cause: this.cause, wall: this.wall, floor: d.floor !== undefined ? d.floor : null, ft: d.ft !== undefined ? d.ft : 0 } as unknown as GameEvent;
    applyEvent(this.world, ev);
    this.events.push(ev);
    return ev;
  }

  /** 使った乱数ストリームの状態を rng_advanced として確定させる */
  finish(): GameEvent[] {
    const states: Record<string, [number, number, number, number]> = {};
    let changed = false;
    for (const [k, r] of this.rngs) {
      const s = r.state();
      const prev = this.world.secret.rng[k];
      if (!prev || prev.some((v, i) => v !== s[i])) {
        states[k] = s;
        changed = true;
      }
    }
    if (changed) this.emit({ type: 'rng_advanced', states, seenBy: [], floor: null, ft: 0 } as EventDraft);
    this.rngs.clear();
    return this.events;
  }

  newEntityId(): string {
    for (;;) {
      const id = opaqueId(this.rng('ids'), 'e_', 6);
      if (!this.world.entities[id]) return id;
    }
  }

  newPlayerId(): string {
    for (;;) {
      const id = opaqueId(this.rng('ids'), 'p_', 4);
      if (!this.world.players[id]) return id;
    }
  }

  /** 次の sid（挿入順） */
  nextSid(): number {
    return this.world.seq + 1;
  }

  // ---- クエリ（読み取りのみ） ----

  entity(id: string): Entity | undefined {
    return this.world.entities[id];
  }

  /** フロア上のエンティティ（sid 順） */
  entitiesOn(key: FloorKey): Entity[] {
    let list = this.floorEnts.get(key);
    if (!list) {
      list = [];
      for (const e of Object.values(this.world.entities)) if (e.pos?.floor === key) list.push(e);
      list.sort((a, b) => a.sid - b.sid);
      this.floorEnts.set(key, list);
    }
    // entity_moved は pos を差し替えるだけなので一覧は有効。呼び出し側が変更しないようコピーを返す
    return list.slice();
  }

  private onFloor(key: FloorKey): Entity[] {
    if (!this.floorEnts.has(key)) this.entitiesOn(key);
    return this.floorEnts.get(key)!;
  }

  actorAt(key: FloorKey, x: number, y: number): Entity | undefined {
    for (const e of this.onFloor(key)) {
      if (e.actor && e.pos && e.pos.floor === key && e.pos.x === x && e.pos.y === y && (e.stats?.hp ?? 1) > 0) return e;
    }
    return undefined;
  }

  itemsAt(key: FloorKey, x: number, y: number): Entity[] {
    const out: Entity[] = [];
    for (const e of this.onFloor(key)) {
      if (e.item && e.pos && e.pos.floor === key && e.pos.x === x && e.pos.y === y) out.push(e);
    }
    return out;
  }

  /** 地物または罠 */
  /** そのマスの地物か罠。野営の火（S1）は入れない（ほかの世界では、その世界の地物・罠と同じマスに置かれることがあり、それらを今までどおり働かせる） */
  featureAt(key: FloorKey, x: number, y: number): Entity | undefined {
    for (const e of this.onFloor(key)) {
      if ((e.feature || e.trap) && !e.campfire && e.pos && e.pos.floor === key && e.pos.x === x && e.pos.y === y) return e;
    }
    return undefined;
  }

  /** そのマスの野営の火（S1。SEASON.md §8） */
  campfireAt(key: FloorKey, x: number, y: number): Entity | undefined {
    for (const e of this.onFloor(key)) {
      if (e.campfire && e.pos && e.pos.floor === key && e.pos.x === x && e.pos.y === y) return e;
    }
    return undefined;
  }

  terrainAt(key: FloorKey, x: number, y: number): TerrainDef {
    const f = this.world.floors[key];
    if (x < 0 || y < 0 || x >= f.width || y >= f.height) return this.content.terrain[0];
    const id = this.world.meta.terrainTable[f.terrain[y * f.width + x]];
    return this.content.terrain[this.content.terrainIndex[id]] ?? this.content.terrain[0];
  }

  terrainIdx(id: string): number {
    const i = this.world.meta.terrainTable.indexOf(id);
    if (i < 0) throw new Error(`terrain not in run table: ${id}`);
    return i;
  }

  playerOf(e: Entity): PlayerRecord | undefined {
    return e.player ? this.world.players[e.player] : undefined;
  }

  /** フロア上の生存プレイヤー（参加順） */
  playersOn(key: FloorKey): PlayerRecord[] {
    const out: PlayerRecord[] = [];
    for (const pid of this.world.playerOrder) {
      const p = this.world.players[pid];
      if (p.state !== 'alive') continue;
      const e = this.world.entities[p.entityId];
      if (e?.pos?.floor === key) out.push(p);
    }
    return out;
  }

  locale(e: Entity | undefined): Locale {
    return (e && this.playerOf(e)?.locale) || 'ja';
  }

  visibleSet(pid: PlayerId): Set<number> {
    let s = this.visCache.get(pid);
    if (!s) {
      s = new Set(this.world.players[pid].knowledge.visible);
      this.visCache.set(pid, s);
    }
    return s;
  }

  /** そのセルを今見ているプレイヤー */
  seersOf(key: FloorKey, p: Pos): PlayerId[] {
    const f = this.world.floors[key];
    const idx = p.y * f.width + p.x;
    return this.playersOn(key).filter((pr) => this.visibleSet(pr.id).has(idx)).map((pr) => pr.id);
  }

  /**
   * プレイヤー pid から、key の pos にいる者が見えるか（V4-0c §4.2: 見えるかどうかの判定は 1 つ。actorSeen）。
   * マスが視界にあり、かつ背の高い草の中でないか隣にいる
   */
  seesActorAt(pid: PlayerId, key: FloorKey, pos: Pos): boolean {
    const pr = this.world.players[pid];
    const me = pr ? this.world.entities[pr.entityId] : undefined;
    const f = this.world.floors[key];
    if (!f || me?.pos?.floor !== key) return false;
    return actorSeen(this.world, key, pos, me.pos, this.visibleSet(pid).has(pos.y * f.width + pos.x));
  }

  /** プレイヤー pid から、その者が見えるか（本人は常に見える） */
  seesActor(pid: PlayerId, e: Entity): boolean {
    if (e.player === pid) return true;
    return !!e.pos && this.seesActorAt(pid, e.pos.floor, e.pos);
  }

  /** 地形変化の知覚: そのセルが見えている者だけが知る（行為者が見えなければ by を伏せる。草の中の行為者も。V4-0c） */
  tileSeen(key: FloorKey, p: Pos, actor: Entity | null): { seenBy: PlayerId[]; masks?: Record<PlayerId, string[]> } {
    const seen = new Set(this.seersOf(key, p));
    if (actor?.player) seen.add(actor.player);
    const masks: Record<PlayerId, string[]> = {};
    for (const pid of seen) {
      if (actor && actor.player !== pid && actor.pos && !this.seesActorAt(pid, key, actor.pos)) masks[pid] = ['by'];
    }
    const seenBy = [...seen].sort();
    return Object.keys(masks).length ? { seenBy, masks } : { seenBy };
  }

  /**
   * 複数の主体を持つイベントの seenBy と masks を計算する。
   * 主体のどれかが見えていれば知覚でき、見えていない主体のフィールドは伏せる。
   */
  perceive(key: FloorKey, subjects: PerceiveSubject[], always: PlayerId[] = []): { seenBy: PlayerId[]; masks?: Record<PlayerId, string[]> } {
    const seen = new Set<PlayerId>(always);
    const masks: Record<PlayerId, string[]> = {};
    for (const pr of this.playersOn(key)) {
      const hidden: string[] = [];
      let any = false;
      const shown: boolean[] = [];
      for (const s of subjects) {
        let visible = this.subjectSeen(pr, key, s);
        // 見えていた者が草に入って見えなくなる移動: 出どころが見えていたので、行き先も伝える（V4-0c §4.2）
        if (!visible && s.enterFrom !== undefined && shown[s.enterFrom] && s.pos) {
          const f = this.world.floors[key];
          visible = this.visibleSet(pr.id).has(s.pos.y * f.width + s.pos.x);
        }
        shown.push(visible);
        if (visible) any = true;
        else hidden.push(s.field);
      }
      if (any || seen.has(pr.id)) {
        seen.add(pr.id);
        if (hidden.length) masks[pr.id] = hidden;
      }
    }
    const seenBy = [...seen].sort();
    return Object.keys(masks).length ? { seenBy, masks } : { seenBy };
  }

  /**
   * 主体 1 つが、そのプレイヤーに見えるか。者（モンスター・プレイヤー）なら actorSeen（草の中は隣からだけ）、
   * それ以外（品・地物・マス）はマスが視界にあるか
   */
  private subjectSeen(pr: PlayerRecord, key: FloorKey, s: PerceiveSubject): boolean {
    if (s.entity && s.entity === pr.entityId) return true;
    if (!s.pos) return false;
    const f = this.world.floors[key];
    const cell = this.visibleSet(pr.id).has(s.pos.y * f.width + s.pos.x);
    const ent = s.entity ? this.world.entities[s.entity] : undefined;
    const isActor = s.actor ?? !!(ent?.actor || ent?.player);
    if (!isActor) return cell;
    return actorSeen(this.world, key, s.pos, this.world.entities[pr.entityId]?.pos, cell);
  }

  /**
   * 者の移動（歩く・入れ替わる）の知覚（V4-0c §4.2）: 出どころと行き先を、その者が見えるかで伏せる。
   * 見えていた者が草に入って見えなくなる移動は、行き先も伝える（最後に見た場所）。草から草へ・見えない者の移動は伝えない
   */
  perceiveMove(key: FloorKey, e: Entity, from: Pos, to: Pos, always: PlayerId[] = []): { seenBy: PlayerId[]; masks?: Record<PlayerId, string[]> } {
    return this.perceive(key, [{ field: 'from', pos: from, entity: e.id }, { field: 'to', pos: to, entity: e.id, enterFrom: 0 }], always);
  }
}

/**
 * 出来事の主体: field を伏せるかどうかを pos（と entity）から決める。
 * actor: 者として扱う（まだ World にいない生まれたばかりの者）。enterFrom: その番号の主体が見えていれば、マスが視界にあるだけで見える（草に入る移動の行き先）
 */
export interface PerceiveSubject { field: string; pos: Pos | null | undefined; entity?: string | null; actor?: boolean; enterFrom?: number }

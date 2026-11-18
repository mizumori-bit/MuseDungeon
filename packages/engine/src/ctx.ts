// 1 回の step の実行文脈。イベントを発行 → 即 applyEvent を繰り返す。
// World を書き換えるのは applyEvent だけ（ここでも直接代入はしない）。
import type { Content, TerrainDef } from '@muse/content';
import type {
  Entity, EventDraft, FloorKey, GameEvent, Locale, PlayerId, PlayerRecord, Pos, World,
} from '@muse/shared';
import { applyEvent, opaqueId, Rng } from '@muse/shared';

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

  emit<D extends EventDraft>(draft: D): GameEvent {
    const floor = draft.floor !== undefined ? draft.floor : this.curFloor;
    const ft = draft.ft !== undefined ? draft.ft : this.now;
    const ev = { ...draft, seq: this.world.seq + 1, cause: this.cause, wall: this.wall, floor, ft } as unknown as GameEvent;
    applyEvent(this.world, ev);
    this.events.push(ev);
    if (ev.type === 'knowledge_updated' && (ev as any).visible) this.visCache.delete((ev as any).player);
    if (ev.type === 'tile_changed') this.terrainVer.set(ev.floor!, (this.terrainVer.get(ev.floor!) ?? 0) + 1);
    if (ev.type === 'entity_changed_floor' || ev.type === 'player_joined') this.visCache.clear();
    if (ev.put || ev.del || ev.type === 'entity_spawned' || ev.type === 'entity_removed' || ev.type === 'entity_changed_floor' || ev.type === 'player_joined' || ev.type === 'floor_generated') this.floorEnts.clear();
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
  featureAt(key: FloorKey, x: number, y: number): Entity | undefined {
    for (const e of this.onFloor(key)) {
      if ((e.feature || e.trap) && e.pos && e.pos.floor === key && e.pos.x === x && e.pos.y === y) return e;
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

  /** 地形変化の知覚: そのセルが見えている者だけが知る（行為者が見えなければ by を伏せる） */
  tileSeen(key: FloorKey, p: Pos, actor: Entity | null): { seenBy: PlayerId[]; masks?: Record<PlayerId, string[]> } {
    const f = this.world.floors[key];
    const seen = new Set(this.seersOf(key, p));
    if (actor?.player) seen.add(actor.player);
    const masks: Record<PlayerId, string[]> = {};
    for (const pid of seen) {
      if (actor && actor.player !== pid && actor.pos && !this.visibleSet(pid).has(actor.pos.y * f.width + actor.pos.x)) masks[pid] = ['by'];
    }
    const seenBy = [...seen].sort();
    return Object.keys(masks).length ? { seenBy, masks } : { seenBy };
  }

  /**
   * 複数の主体を持つイベントの seenBy と masks を計算する。
   * 主体のどれかが見えていれば知覚でき、見えていない主体のフィールドは伏せる。
   */
  perceive(key: FloorKey, subjects: { field: string; pos: Pos | null | undefined; entity?: string | null }[], always: PlayerId[] = []): { seenBy: PlayerId[]; masks?: Record<PlayerId, string[]> } {
    const f = this.world.floors[key];
    const seen = new Set<PlayerId>(always);
    const masks: Record<PlayerId, string[]> = {};
    for (const pr of this.playersOn(key)) {
      const vis = this.visibleSet(pr.id);
      const hidden: string[] = [];
      let any = false;
      for (const s of subjects) {
        const isSelf = s.entity && s.entity === pr.entityId;
        const visible = isSelf || (s.pos ? vis.has(s.pos.y * f.width + s.pos.x) : false);
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
}

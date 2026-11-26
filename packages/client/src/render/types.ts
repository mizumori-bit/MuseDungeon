// Renderer インターフェース（docs/DESIGN.md §9.1）と、描画対象 Scene。
// Scene は「種別 ID ＋ 状態」だけを持ち、見た目はテーマが決める。
import type { Catalog, Dir, HpState, Pos } from '@muse/shared';
import type { AssetRef, Theme } from '../theme/types';

export interface SceneEntity {
  id: string;
  layer: 'feature' | 'item' | 'actor';
  ref: AssetRef;
  x: number;
  y: number;
  /** ツールチップ用の表示名 */
  label: string;
  /** 正確な HP 比（俯瞰・自分のみ） */
  hpFrac?: number;
  /** 4 段階 HP（プレイヤー視点のモンスター） */
  hpBucket?: HpState;
  isPlayer?: boolean;
  /** プレイヤー識別色 */
  color?: string;
  name?: string;
  statuses: string[];
  affixes: string[];
  asleep?: boolean;
  hostile?: boolean;
  /** 同じセルの他アイテム数（複数ありの印） */
  stack?: number;
  /** 記憶（視界外）に基づく表示 */
  remembered?: boolean;
  /** 俯瞰でのみ見える未発見の罠 */
  hidden?: boolean;
  /** 遠征の目的に関わる個体（守護者・遺物）。テーマに依らずレンダラーが印を重ねる */
  role?: 'guardian' | 'relic' | 'elite';
  /** 宝（持ち帰ると点になるアイテム）。テーマに依らずレンダラーが印を重ねる */
  treasure?: boolean;
}

export interface Scene {
  mode: 'director' | 'player';
  floorKey: string;
  width: number;
  height: number;
  biome: string;
  /** セルごとの地形 ID（未知は null） */
  terrain: (string | null)[];
  /** 0=未知 1=記憶（見たことがある） 2=視界内 3=地形だけ判明（地図の巻物。まだ見ていない） */
  vis: Uint8Array;
  entities: SceneEntity[];
  focus: Pos | null;
  focusId: string | null;
  cursor?: Pos | null;
  path?: Pos[] | null;
  /** 吹き出し（AI の thought など） */
  bubbles: { id: string; text: string }[];
  catalog: Catalog;
  /** 目標（守護者・遺物）の気配。focusId の横に方角の矢印を出す（プレイヤー視点のみ） */
  sense?: { what: 'guardian' | 'relic'; dir: Dir; range: 'far' | 'near' } | null;
  /** 下への風: 今いる階の下り階段が未発見のときの方角（V3-2R2 §18.4）。focusId の横に気配とは別の形の矢印を出す（プレイヤー視点のみ） */
  draft?: Dir | null;
  /**
   * シーズンの印（S2 §18.1。プレイヤー視点のみ）: 公開された下り階段・公開された特別な場所・野営の火。
   * テーマに依らずレンダラーがマスの角に小さな印を重ね、ツールチップに label（公開した者・置いた者の名前）を出す
   */
  marks?: SceneMark[];
}

export interface SceneMark { x: number; y: number; kind: 'public_stairs' | 'public_spot' | 'fire'; label: string }

/** 演出用のイベント（クライアントがゲームイベントから導出する。見た目専用） */
export type ViewEvent =
  | { kind: 'move'; id: string; from: Pos; to: Pos; teleport?: boolean }
  | { kind: 'attack'; id: string | null; from: Pos | null; to: Pos; hit: boolean; crit: boolean; ranged: boolean }
  /**
   * 当たった一撃（S16a。SEASON.md §70.3 の 2）: 攻撃の出来事が届いていない、被害の出来事（近接・射撃）から。位置は描く側が、届いた見え方から引く。
   * 遊ぶ画面と追従だけの観戦の枠には、文になる出来事だけが届く（会心でない当たりの attack は文にならないので、届かない）
   */
  | { kind: 'strike'; id: string; target: string; ranged: boolean }
  /** 能動技・敵の大きな行動の名前（S16a）。使った者の頭の上に短く出す */
  | { kind: 'ability'; id: string; name: string }
  | { kind: 'damage'; id: string; amount: number }
  | { kind: 'heal'; id: string; amount: number }
  | { kind: 'die'; id: string; pos: Pos }
  | { kind: 'projectile'; from: Pos; to: Pos; ref?: AssetRef }
  | { kind: 'levelup'; id: string }
  | { kind: 'status'; id: string; status: string }
  | { kind: 'trap'; pos: Pos };

export interface Renderer {
  mount(canvas: HTMLCanvasElement, theme: Theme): void;
  draw(scene: Scene): void;
  animate(events: ViewEvent[]): Promise<void>;
}

// Renderer インターフェース（docs/DESIGN.md §9.1）と、描画対象 Scene。
// Scene は「種別 ID ＋ 状態」だけを持ち、見た目はテーマが決める。
import type { Catalog, HpState, Pos } from '@muse/shared';
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
}

export interface Scene {
  mode: 'director' | 'player';
  floorKey: string;
  width: number;
  height: number;
  biome: string;
  /** セルごとの地形 ID（未知は null） */
  terrain: (string | null)[];
  /** 0=未知 1=記憶 2=視界内 */
  vis: Uint8Array;
  entities: SceneEntity[];
  focus: Pos | null;
  focusId: string | null;
  cursor?: Pos | null;
  path?: Pos[] | null;
  /** 吹き出し（AI の thought など） */
  bubbles: { id: string; text: string }[];
  catalog: Catalog;
}

/** 演出用のイベント（クライアントがゲームイベントから導出する。見た目専用） */
export type ViewEvent =
  | { kind: 'move'; id: string; from: Pos; to: Pos; teleport?: boolean }
  | { kind: 'attack'; id: string | null; from: Pos | null; to: Pos; hit: boolean; crit: boolean; ranged: boolean }
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

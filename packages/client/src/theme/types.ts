// テーマ: コンテンツ ID → 見た目。ゲーム側は見た目を知らない（docs/ASSET_SPEC.md）。
export type AssetClass = 'terrain' | 'actor' | 'item' | 'appearance' | 'feature' | 'fx' | 'status' | 'affix' | 'ui' | 'scene';

/** 場面の 1 枚絵（ASSET_SPEC §7.7。scene:camp）。グリッドに乗らない。frames: 横に並べたフレームの数（1 フレームは絵全体と同じ大きさ） */
export interface SceneArt { url: string; fit: 'cover' | 'contain'; frames: number; frameMs: number }
export type Facing = 'n' | 'e' | 's' | 'w';

export interface AssetRef {
  cls: AssetClass;
  id: string;
  /** 完全一致が無い時に次に試す ID（鑑定済みアイテム → 外見） */
  alt?: { cls: AssetClass; id: string };
  /** content の category（item:potion などのカテゴリ代替用） */
  category?: string;
  /** 地形のバイオーム別差し替え（terrainId@biomeId） */
  biome?: string;
  /** 地物の状態（used など） */
  state?: string;
  /** バリエーション選択用のセル座標（見た目専用ハッシュ） */
  x?: number;
  y?: number;
  facing?: Facing;
  anim?: string;
  /** mask16 オートタイルの index（北=1 東=2 南=4 西=8） */
  mask?: number;
}

export interface SpriteDrawable {
  kind: 'sprite';
  img: CanvasImageSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** フレーム内のアンカー（0..1）。既定は下端中央 (0.5, 1) */
  anchorX: number;
  anchorY: number;
  flipX: boolean;
}

export interface GlyphDrawable {
  kind: 'glyph';
  ch: string;
  fg: string;
  bg?: string;
  bold?: boolean;
}

export type Drawable = SpriteDrawable | GlyphDrawable;

export interface Theme {
  id: string;
  name: string;
  cellSize: number;
  background: string;
  scaling: 'nearest' | 'linear';
  /** アニメーションする素材を持つ（常時再描画が必要） */
  animated: boolean;
  resolve(ref: AssetRef, now: number): Drawable;
  /** その地形が mask16 オートタイルを使うか */
  usesMask(terrainId: string, biome?: string): boolean;
  /** 画像の読み込み完了などで再描画が必要になったとき */
  onChange(cb: () => void): () => void;
  /** 場面の 1 枚絵（scene 分類。ASSET_SPEC §7.7）。無ければ null（glyph には無い） */
  sceneArt?(id: string): SceneArt | null;
}

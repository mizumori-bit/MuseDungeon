// Command と ActionError。AI（MCP）と人間（WS）は同じ Command スキーマを使う。
import { z } from 'zod';
import type { PlayerId } from './types';

export const DirSchema = z.enum(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);
export const PosSchema = z.object({ x: z.number().int(), y: z.number().int() });
export const EntityRefSchema = z.string().regex(/^e_[0-9a-z]{6}$/);
/** 方向 | 座標 | エンティティ ID */
export const TargetSchema = z.union([DirSchema, PosSchema, EntityRefSchema]);
export const TravelTargetSchema = z.union([PosSchema, z.enum(['stairs_down', 'stairs_up']), EntityRefSchema]);
export const SlotSchema = z.string().regex(/^[a-z]$/);
export const EquipSlotSchema = z.enum(['weapon', 'armor', 'accessory']);
/** 移動マクロの慎重さ（V3-2R §14.2）: careful 既定 / steady 弱い攻撃や毒を受けながら進む / flee 隣に敵がいても退く */
export const MacroModeSchema = z.enum(['careful', 'steady', 'flee']);
export type MacroMode = z.infer<typeof MacroModeSchema>;
const HpFloorSchema = z.number().int().min(0);

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), dir: DirSchema }),
  /** turns: 2〜10 なら何か変化があるまで続けて待つ（サーバーで展開。V3-2R2 §18.5） */
  z.object({ type: z.literal('wait'), turns: z.number().int().min(1).max(10).optional() }),
  z.object({ type: z.literal('pickup'), item: EntityRefSchema.optional() }),
  z.object({ type: z.literal('drop'), slot: SlotSchema, qty: z.number().int().positive().optional() }),
  z.object({ type: z.literal('equip'), slot: SlotSchema }),
  z.object({ type: z.literal('unequip'), slot: z.union([SlotSchema, EquipSlotSchema]) }),
  /** targetSlot: 鑑定の巻物などの対象（所持品のスロット） */
  z.object({ type: z.literal('use'), slot: SlotSchema, target: TargetSchema.optional(), targetSlot: SlotSchema.optional() }),
  z.object({ type: z.literal('throw'), slot: SlotSchema, target: TargetSchema }),
  z.object({ type: z.literal('interact'), dir: DirSchema.optional() }),
  z.object({ type: z.literal('stairs') }),
  // マクロ（サーバーで基本行動へ展開）
  /** toward: 'draft' は下への風の方角の未探索を優先する（V3-2R3 §20.5） */
  // pickup: 'useful'（explore の既定）は劣る装備を拾わない、true は全部、false は拾わない。toward: draft（下への風）/ sense（遺物・守護者の気配。V3-4b §28.7）
  z.object({ type: z.literal('explore'), mode: MacroModeSchema.optional(), hpFloor: HpFloorSchema.optional(), pickup: z.union([z.boolean(), z.literal('useful')]).optional(), toward: z.enum(['draft', 'sense']).optional() }),
  z.object({ type: z.literal('travel'), to: TravelTargetSchema, mode: MacroModeSchema.optional(), hpFloor: HpFloorSchema.optional(), pickup: z.union([z.boolean(), z.literal('useful')]).optional() }),
  z.object({ type: z.literal('rest'), untilHp: z.number().int().positive().optional(), maxTurns: z.number().int().positive().optional() }),
  /** 既知の「自分が投げた物」（what: 'thrown'、既定）か、見えている・記憶したアイテム（'items'）を近い順に拾う */
  z.object({ type: z.literal('collect'), what: z.enum(['thrown', 'items']).optional(), mode: MacroModeSchema.optional(), hpFloor: HpFloorSchema.optional() }),
  /**
   * その相手と決着を付ける（V3-2R2 §18.5）。with なし: 近接（追跡中の相手は隣に来るまで待つ）。with: そのスロットの品を投げて戦う（射程と射線が通るまで待つ）。
   * 倒れた・離れた・HP が hpFloor を下回った・別の追跡中の敵・状態異常で止まる
   */
  /** abilities: 使える手番ごとに使う能動技（強打・なぎ払い・狙い撃ち。V3-4a §25.3） */
  // until: 'clear' は標的を倒した後も、届く追跡中の敵へ続ける。adjacent: with で投げて戦う相手が隣に来たとき（既定 stop）。
  // lostOk: 標的が直前の応答では見えていて逃げていなかった（今見えなくても待つ。PlayerPort が付ける。V3-4b §28.4）
  z.object({ type: z.literal('fight'), target: EntityRefSchema, with: SlotSchema.optional(), hpFloor: HpFloorSchema.optional(), abilities: z.array(z.string().min(1)).max(4).optional(),
    until: z.enum(['target', 'clear']).optional(), adjacent: z.enum(['throw', 'melee', 'stop']).optional(), lostOk: z.boolean().optional() }),
  /** 近接攻撃（V3-4）。隣の敵か、長柄の武器なら直線で 2 マス先の敵（間のマスが通れて誰もいない） */
  z.object({ type: z.literal('attack'), target: EntityRefSchema }),
  /** 能動技（V3-4 §4.2）。target: 隣の敵・投擲の対象なら ID、身をかわすなら方向。slot: 狙い撃ちで投げる品（省略時は投擲用の品の最初のスロット） */
  z.object({ type: z.literal('ability'), id: z.string().min(1), target: z.union([DirSchema, EntityRefSchema]).optional(), slot: SlotSchema.optional() }),
  // 遠征
  z.object({ type: z.literal('extract'), confirm: z.boolean().optional() }),
  z.object({ type: z.literal('start_expedition'), offer: z.union([z.number().int().min(1).max(9), z.literal('endless')]) }),
  // 手番を消費しない
  z.object({ type: z.literal('say'), text: z.string().min(1).max(280) }),
  z.object({ type: z.literal('note'), add: z.string().min(1).max(280).optional(), remove: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal('retire') }),
  /** 特技を選ぶ（手番を消費しない。V3-4 §4.1）。option は候補の番号（1 から）か特技の ID */
  z.object({ type: z.literal('choose_perk'), option: z.union([z.number().int().min(1).max(9), z.string().min(1)]) }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command['type'];
export type Target = z.infer<typeof TargetSchema>;
export type TravelTarget = z.infer<typeof TravelTargetSchema>;

export const MACRO_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['explore', 'travel', 'rest', 'collect', 'fight']);
export const FREE_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['say', 'note', 'retire', 'choose_perk']);
/** キャンプでのみ有効（手番に関係しない） */
export const CAMP_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['start_expedition']);

/** システムコマンド（参加・離脱）。commands.jsonl に記録し、決定論的再実行で流す */
export const JoinSchema = z.object({
  type: z.literal('join'),
  name: z.string().min(1).max(32),
  classId: z.string().optional(),
  controller: z.object({ kind: z.enum(['agent', 'human']), label: z.string().max(64) }),
  locale: z.enum(['ja', 'en']).default('ja'),
  /** 参加したらキャンプに入る（最初の遠征を候補から選ぶ。V3-2R §14.4） */
  atCamp: z.boolean().optional(),
});
export type JoinCommand = z.infer<typeof JoinSchema>;

export type CommandSource = 'mcp' | 'ws' | 'macro' | 'timeout' | 'bot' | 'system';

export interface CommandRecord {
  cseq: number;
  player: PlayerId | null;
  command: Command | JoinCommand;
  source: CommandSource;
  /** マクロ展開元の cseq */
  parent?: number;
  /** マクロ呼び出しそのもの（イベント無し・再実行では流さない） */
  macro?: boolean;
  thought?: string;
  wall: number;
  resultSeq: [number, number] | null;
  /** join の結果として払い出されたプレイヤー ID（監査用） */
  assigned?: PlayerId;
}

export type ActionErrorCode =
  | 'invalid_direction' | 'blocked' | 'no_target' | 'out_of_range' | 'no_line_of_sight'
  | 'no_such_item' | 'cannot_use' | 'inventory_full' | 'nothing_here' | 'unknown_destination'
  | 'unreachable' | 'not_your_turn' | 'stale_turn' | 'dead' | 'run_ended' | 'no_session' | 'bad_request'
  | 'confirm_required' | 'cannot_extract' | 'not_at_camp' | 'at_camp'
  // マクロが 1 歩も進めないと分かったとき（手番を使わない。V3-2R §14.2）
  | 'hostile_adjacent' | 'hostile_in_view' | 'hp_floor' | 'nothing_to_do';

export interface ActionError {
  code: ActionErrorCode;
  /** 何が起きたか */
  message: string;
  /** 次に何をすればよいか */
  hint: string;
}

export function actionError(code: ActionErrorCode, message: string, hint: string): ActionError {
  return { code, message, hint };
}

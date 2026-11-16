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

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), dir: DirSchema }),
  z.object({ type: z.literal('wait') }),
  z.object({ type: z.literal('pickup'), item: EntityRefSchema.optional() }),
  z.object({ type: z.literal('drop'), slot: SlotSchema, qty: z.number().int().positive().optional() }),
  z.object({ type: z.literal('equip'), slot: SlotSchema }),
  z.object({ type: z.literal('unequip'), slot: z.union([SlotSchema, EquipSlotSchema]) }),
  z.object({ type: z.literal('use'), slot: SlotSchema, target: TargetSchema.optional() }),
  z.object({ type: z.literal('throw'), slot: SlotSchema, target: TargetSchema }),
  z.object({ type: z.literal('interact'), dir: DirSchema.optional() }),
  z.object({ type: z.literal('stairs') }),
  // マクロ（サーバーで基本行動へ展開）
  z.object({ type: z.literal('explore') }),
  z.object({ type: z.literal('travel'), to: TravelTargetSchema }),
  z.object({ type: z.literal('rest'), untilHp: z.number().int().positive().optional(), maxTurns: z.number().int().positive().optional() }),
  /** 既知の「自分が投げた物」を近い順に回収する */
  z.object({ type: z.literal('collect') }),
  // 遠征
  z.object({ type: z.literal('extract'), confirm: z.boolean().optional() }),
  z.object({ type: z.literal('start_expedition'), offer: z.union([z.number().int().min(1).max(9), z.literal('endless')]) }),
  // 手番を消費しない
  z.object({ type: z.literal('say'), text: z.string().min(1).max(280) }),
  z.object({ type: z.literal('note'), add: z.string().min(1).max(280).optional(), remove: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal('retire') }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command['type'];
export type Target = z.infer<typeof TargetSchema>;
export type TravelTarget = z.infer<typeof TravelTargetSchema>;

export const MACRO_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['explore', 'travel', 'rest', 'collect']);
export const FREE_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['say', 'note', 'retire']);
/** キャンプでのみ有効（手番に関係しない） */
export const CAMP_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>(['start_expedition']);

/** システムコマンド（参加・離脱）。commands.jsonl に記録し、決定論的再実行で流す */
export const JoinSchema = z.object({
  type: z.literal('join'),
  name: z.string().min(1).max(32),
  classId: z.string().optional(),
  controller: z.object({ kind: z.enum(['agent', 'human']), label: z.string().max(64) }),
  locale: z.enum(['ja', 'en']).default('ja'),
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
  | 'confirm_required' | 'cannot_extract' | 'not_at_camp' | 'at_camp';

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

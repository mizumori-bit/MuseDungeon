// 指図（S8。SEASON.md §54）: 持ち主が握った項目の命令は、持ち主の口からだけ通る。
// 握っているかどうかは World（PlayerRecord.directive）にあり、だれの口から来たかは命令に付けて渡される（記録の source が owner か）。
// 再生でも、記録だけで同じ判定になる。断りは手番を使わず、World を変えない（出来事を出さない）。
import type { ActionError, Command, DirectiveItem, PlayerRecord, World } from '@muse/shared';
import { actionError, DIRECTIVE_ITEMS, t } from '@muse/shared';
import type { Ctx } from './ctx';

/** 指図を出せるラン（§54.1）: ソロで、プレイヤーが人間でないもの（人間が自分で遊ぶランと、協力プレイには出さない） */
export function directiveTarget(world: World, pr: PlayerRecord): boolean {
  return world.meta.mode === 'solo' && pr.controller.kind !== 'human';
}

/** 命令が握られる項目（握れる命令でなければ null） */
export function heldItemOf(cmd: Command): DirectiveItem | null {
  switch (cmd.type) {
    case 'start_expedition': return 'objective';
    case 'equip': case 'unequip': return 'loadout';
    case 'choose_perk': case 'choose_boon': return 'perks';
    default: return null;
  }
}

/** 項目の名前（文） */
export function directiveItemName(L: 'ja' | 'en', item: DirectiveItem): string {
  return item === 'objective' ? t(L, '目的', 'the objective') : item === 'loadout' ? t(L, '装備', 'equipment') : t(L, '特技と加護', 'perks and boons');
}

/** 握られた項目の断り（プレイヤーの口から。手番を使わない） */
export function heldError(L: 'ja' | 'en', item: DirectiveItem, inDungeon: boolean): ActionError {
  // 世界の中での読み方（依頼者と決めた言い方。SEASON.md §55）: 主は「キャンプで、持ち主が決める」。読み方は添える。「鑑定」とは言わない（キャンプは品の正体や呪いを明かさない）
  if (item === 'objective') {
    return actionError('held_by_owner',
      t(L, '次の遠征の目的は、持ち主がキャンプで決める（指図）。あなたの start_expedition は通らない。', 'Your owner decides the next expedition at camp (directive). Your start_expedition does not go through.'),
      t(L, 'wait_for_turn で、持ち主が遠征を始めるまで待てる（手番は減らない）。observe で確かめてもよい。', 'wait_for_turn waits until your owner starts the expedition (no turns are spent). You can also check with observe.'));
  }
  if (item === 'loadout') {
    return inDungeon
      ? actionError('held_by_owner',
        t(L, '装備は、持ち主がキャンプで決める（指図）。迷宮で手に入れた装備は、キャンプで確かめるまで身に着けない（今の装備を外すのも、装備中の品を捨てるのも、キャンプまで待つ）。あなたの equip・unequip は通らない。', 'Your owner decides your equipment at camp (directive). Gear found in the dungeon is not worn until it is looked over at camp (taking off or dropping what you wear also waits for camp). Your equip / unequip do not go through.'),
        t(L, '今の装備のまま進む。手に入れた装備は、持ち帰れば、キャンプで持ち主が決める。拾う・捨てる（装備中の品を除く）・使う・投げるは、あなたが決める。', 'Carry on with what you wear. Bring found gear home and your owner decides at camp. Picking up, dropping (except what you wear), using and throwing are still yours.'))
      : actionError('held_by_owner',
        t(L, '装備は、持ち主がキャンプで決める（指図）。あなたの equip・unequip は通らない。', 'Your owner decides your equipment at camp (directive). Your equip / unequip do not go through.'),
        t(L, '今の装備は、観測の所持品の * の品。', 'What you wear is marked * in the inventory.'));
  }
  return actionError('held_by_owner',
    t(L, '特技と加護は、持ち主がキャンプで決める（指図）。遠征の間に強くなって覚えられることが増えても、身につけるのはキャンプに戻ってから（持ち主が選ぶ。選ぶまで、進行は止まらない）。あなたの choose_perk・choose_boon は通らない。', 'Your owner decides perks and boons at camp (directive). What you grow able to learn during an expedition is taken up only back at camp (your owner picks; the game goes on meanwhile). Your choose_perk / choose_boon do not go through.'),
    t(L, 'そのまま続けてよい。', 'Carry on.'));
}

function equippedSlot(world: World, pr: PlayerRecord, slot: string): boolean {
  const me = world.entities[pr.entityId];
  return Object.values(me?.equip ?? {}).some((id) => !!id && world.entities[id]?.item?.slot === slot);
}

/**
 * 指図の門（engine の step の初め）: 断るならその断り（出来事を出さない）。通すなら null。
 * owner: 命令が持ち主の口から来た（記録の source: owner）
 */
export function directiveGate(world: World, pr: PlayerRecord, cmd: Command, owner: boolean): ActionError | null {
  const L = pr.locale;
  const hold = pr.directive?.hold ?? [];
  if (cmd.type === 'set_directive') {
    if (!owner) return actionError('bad_request', t(L, 'set_directive は持ち主の口からだけ（人間の画面の、持ち主の枠）。プレイヤーの命令ではない。', 'set_directive comes only from the owner (the owner panel in the browser). It is not a player command.'), '');
    if (!directiveTarget(world, pr)) return actionError('bad_request', t(L, '指図は、ソロで、人間が自分で遊んでいないランだけ。', 'Directives apply only to solo runs not played by a human.'), '');
    if (pr.state !== 'at_camp' || world.status === 'ended') return actionError('not_at_camp', t(L, '指図は、キャンプでだけ変えられる（遠征の途中は、見守る）。', 'Directives can be changed only at camp (during an expedition, you watch).'), t(L, 'AI がキャンプに戻ってから。', 'Wait until your AI is back at camp.'));
    return null;
  }
  const item = heldItemOf(cmd);
  if (owner) {
    if (!item || !hold.includes(item)) {
      const held = hold.map((x) => directiveItemName(L, x)).join(t(L, '・', ', ')) || t(L, 'なし', 'none');
      return actionError('bad_request', t(L, `持ち主の口から出せるのは、set_directive と、握った項目の命令だけ（いま握っている: ${held}）。`, `From the owner you can send set_directive and the commands of the items you hold only (held now: ${held}).`), t(L, '握るには set_directive { hold }。', 'Hold an item with set_directive { hold }.'));
    }
    if (pr.state !== 'at_camp' || world.status === 'ended') return actionError('not_at_camp', t(L, '持ち主が決めるのは、キャンプでだけ（遠征の途中は、見守る）。', 'The owner decides only at camp (during an expedition, you watch).'), t(L, 'AI がキャンプに戻ってから。', 'Wait until your AI is back at camp.'));
    return null;
  }
  if (item && hold.includes(item)) return heldError(L, item, pr.state === 'alive');
  // 装備を握っている遠征の間は、装備中の品を捨てられない（付け替えに数える。§54.3「遠征の間は、だれも付け替えられない」）
  if (cmd.type === 'drop' && hold.includes('loadout') && pr.state === 'alive' && equippedSlot(world, pr, cmd.slot)) return heldError(L, 'loadout', true);
  return null;
}

/** 伝言の文（§54.2）: 制御文字・書式の文字（向きの上書きなど）を落とし、改行とタブは空白に。前後の空白を除く（長さの上限は setDirective が見る） */
export function cleanDirectiveMessage(s: string): string {
  let out = '';
  let gap = false;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // 改行・タブなど（続けば 1 つの空白）
    if (c >= 9 && c <= 13) { if (!gap) out += ' '; gap = true; continue; }
    // 制御文字（C0・DEL・C1）・幅の無い文字と向きの指定（U+200B〜200F・202A〜202E・2060〜206F・FEFF）
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff) continue;
    out += ch;
    gap = false;
  }
  return out.trim();
}

/** 伝言の長さの上限（落とした後の文字数。S8a） */
export const DIRECTIVE_MESSAGE_MAX = 280;

/** set_directive（門を通った後）: 変わっていなければ断る（出来事を出さない） */
export function setDirective(ctx: Ctx, pr: PlayerRecord, cmd: Extract<Command, { type: 'set_directive' }>): ActionError | null {
  const hold = DIRECTIVE_ITEMS.filter((x) => cmd.hold.includes(x));
  const message = cleanDirectiveMessage(cmd.message ?? '');
  // 長さは、制御文字などを落とした後の文字数で数える（S8a §55.6 の 10）
  if (message.length > DIRECTIVE_MESSAGE_MAX) return actionError('bad_request', t(pr.locale, `伝言は ${DIRECTIVE_MESSAGE_MAX} 字まで（いま ${message.length} 字）。`, `A message is up to ${DIRECTIVE_MESSAGE_MAX} characters (now ${message.length}).`), '');
  const cur = pr.directive ?? { hold: [], message: '' };
  if (cur.hold.join(',') === hold.join(',') && cur.message === message) {
    return actionError('nothing_to_do', t(pr.locale, '指図は変わっていない。', 'The directive is unchanged.'), '');
  }
  ctx.emit({ type: 'directive_set', player: pr.id, directiveAfter: { hold, message }, seenBy: [pr.id], floor: null });
  return null;
}

/** 持ち主の口から握った項目を決めた（§54.6: 順位の印の元）。同じ命令の出来事の後に出す */
export function noteOwnerDecided(ctx: Ctx, pid: string, item: DirectiveItem, act: 'start_expedition' | 'equip' | 'unequip' | 'choose_perk' | 'choose_boon', extra: { no?: number; kind?: string | null; appearanceId?: string | null; choice?: string } = {}): void {
  const cur = ctx.world.players[pid]?.ownerDecided ?? [];
  const after = DIRECTIVE_ITEMS.filter((x) => x === item || cur.includes(x));
  ctx.emit({ type: 'owner_decided', player: pid, item, act, ...extra, decidedAfter: after, seenBy: [pid], floor: null });
}

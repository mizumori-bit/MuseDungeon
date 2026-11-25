// 指図（S8。SEASON.md §54）: 持ち主が握った項目の命令は、持ち主の口からだけ通る。
// 握っているかどうかは World（PlayerRecord.directive）にあり、だれの口から来たかは命令に付けて渡される（記録の source が owner か）。
// 再生でも、記録だけで同じ判定になる。断りは手番を使わない。
// 支度の札（S9。§58.1）: 握っている項目があれば、キャンプに着くたびに engine が「まだ」か「準備完了」に置く。「まだ」の間、プレイヤーの start_expedition は断る。
// 希望（S9。§58.2）: 握られた項目の命令をプレイヤーの口から出すと、断ったうえで、出来事 directive_wish で覚える（手番は使わない）。
import type { Content } from '@muse/content';
import type { ActionError, Command, Directive, DirectiveItem, DirectivePrep, DirectiveWish, EquipSlot, PlayerRecord, PrepNeeds, World, WishItem } from '@muse/shared';
import { actionError, DIRECTIVE_ITEMS, EQUIP_SLOTS, prepNeedsAny, prepNeedsParts, prepStateOf, putWish, sameWish, seasonBudgetLeft, t, wishLabel, wishReason, wishToldText } from '@muse/shared';
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

/** 待ち方の文（S9 §58.1。持ち主の支度を待つ） */
function prepWaitHint(L: 'ja' | 'en'): string {
  return t(L, 'wait_for_turn で、持ち主の支度が準備完了になるまで待てる（手番は減らない）。observe で確かめてもよい。',
    'wait_for_turn waits until your owner\'s preparations are ready (no turns are spent). You can also check with observe.');
}

/** 「まだ」の中身（決めていないもの。無ければ、持ち主が支度を見直している） */
function pendingText(L: 'ja' | 'en', needs: PrepNeeds): string {
  const parts = prepNeedsParts(L, needs);
  return parts.length ? t(L, `決めていないもの: ${parts.join('・')}`, `not yet decided: ${parts.join('; ')}`) : t(L, '持ち主が、支度を見直している', 'your owner is going over the preparations');
}

/** 握られた項目の断り（プレイヤーの口から。手番を使わない） */
export function heldError(L: 'ja' | 'en', item: DirectiveItem, inDungeon: boolean): ActionError {
  // 世界の中での読み方（依頼者と決めた言い方。SEASON.md §55）: 主は「キャンプで、持ち主が決める」。読み方は添える。「鑑定」とは言わない（キャンプは品の正体や呪いを明かさない）
  if (item === 'objective') {
    return actionError('held_by_owner',
      t(L, '次の遠征の目的は、持ち主がキャンプで決める（指図）。あなたの start_expedition は、持ち主の支度が準備完了になるまで断られる（準備完了の後は、持ち主が選んだ目的で始まる）。', 'Your owner decides the next expedition at camp (directive). Your start_expedition is refused until your owner\'s preparations are ready (after that, it starts with the objective your owner chose).'),
      prepWaitHint(L));
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
    t(L, '特技と加護は、持ち主がキャンプで決める（指図）。遠征の間に強くなって覚えられることが増えても、身につけるのはキャンプに戻ってから（持ち主が選ぶ。遠征の途中は、止まらない。キャンプでは、持ち主の支度を待つ）。あなたの choose_perk・choose_boon は通らない。', 'Your owner decides perks and boons at camp (directive). What you grow able to learn during an expedition is taken up only back at camp (your owner picks; an expedition does not stop for it, but at camp you wait for your owner\'s preparations). Your choose_perk / choose_boon do not go through.'),
    t(L, 'そのまま続けてよい。', 'Carry on.'));
}

/** 希望を覚えたときの断り（S9 §58.2） */
function wishError(L: 'ja' | 'en', label: string, item: DirectiveItem, inDungeon: boolean, pending: string | null): ActionError {
  const head = wishToldText(L, label);
  const hint = item === 'objective'
    ? t(L, '持ち主の支度が準備完了になったら、start_expedition で出発する（目的は、持ち主が選んだもの）。', 'Once your owner\'s preparations are ready, set out with start_expedition (with the objective your owner chose).') + prepWaitHint(L)
    : inDungeon
      ? item === 'loadout'
        ? t(L, '今の装備のまま進む。手に入れた装備は、持ち帰れば、キャンプで持ち主が決める。', 'Carry on with what you wear; bring found gear home and your owner decides at camp.')
        : t(L, 'そのまま続けてよい（身につけるのは、キャンプに戻ってから）。', 'Carry on (it is taken up back at camp).')
      : t(L, '持ち主がキャンプで決める。', 'Your owner decides at camp.') + prepWaitHint(L);
  const e = actionError('held_by_owner', pending ? `${head}${t(L, `持ち主の支度は、まだ（${pending}）。`, ` Your owner's preparations are not ready yet (${pending}).`)}` : head, hint);
  e.details = { wish: true };
  return e;
}

function equippedSlot(world: World, pr: PlayerRecord, slot: string): boolean {
  const me = world.entities[pr.entityId];
  return Object.values(me?.equip ?? {}).some((id) => !!id && world.entities[id]?.item?.slot === slot);
}

/** 持ち物の品の ID（ID の順。支度の札の seen） */
export function invIds(world: World, pr: PlayerRecord): string[] {
  return [...(world.entities[pr.entityId]?.inv?.items ?? [])].sort();
}

/**
 * 支度で、持ち主がまだ決めていないもの（S9 §58.1。World から数える。観測は PlayerView から同じものを数える）。hold: 握る項目（set_directive の後の値で数えるときに渡す）
 */
export function prepNeedsWorld(world: World, content: Content, pr: PlayerRecord, hold: readonly DirectiveItem[], prep: DirectivePrep | undefined): PrepNeeds {
  const me = world.entities[pr.entityId];
  const out: PrepNeeds = {};
  if (hold.includes('objective') && prep?.objective === undefined) out.objective = true;
  if (hold.includes('perks')) {
    const p = me?.build?.pending ?? [];
    if (p[0]?.options.length) out.perk = { level: p[0].level, options: p[0].options.length, more: Math.max(0, p.length - 1) };
    if (me?.boonChoice?.options.length) out.boon = { depth: me.boonChoice.depth, options: me.boonChoice.options.length };
  }
  if (hold.includes('loadout')) {
    const seen = new Set(prep?.seen ?? []);
    const worn = new Set(Object.values(me?.equip ?? {}).filter((x): x is string => !!x));
    const n = (me?.inv?.items ?? []).filter((id) => !seen.has(id) && !worn.has(id) && !!content.items[world.entities[id]?.kind ?? '']?.equip).length;
    if (n) out.gear = n;
  }
  return out;
}

/** 新しい札（決めるものが無ければ準備完了、あれば「まだ」。seen は今の持ち物） */
function freshPrep(world: World, content: Content, pr: PlayerRecord, hold: readonly DirectiveItem[], seenBase?: string[]): DirectivePrep {
  const base: DirectivePrep = { state: 'pending', seen: seenBase ? [...seenBase] : invIds(world, pr) };
  return prepNeedsAny(prepNeedsWorld(world, content, pr, hold, base)) ? base : { state: 'ready', seen: invIds(world, pr) };
}

/** 指図の after 値（prep・wishes は、あるときだけ。並びを決めて、同じ中身が同じ値になるように） */
function directiveOf(hold: DirectiveItem[], message: string, prep: DirectivePrep | undefined, wishes: DirectiveWish[] | undefined): Directive {
  return { hold, message, ...(prep ? { prep } : {}), ...(wishes?.length ? { wishes } : {}) };
}

/** 希望の項目が、握る項目のどれに当たるか */
function wishHeld(w: WishItem): DirectiveItem {
  return w === 'objective' ? 'objective' : w === 'loadout' ? 'loadout' : 'perks';
}

/** 覚える希望の下書き（S9 §58.2）。same: いま覚えている希望と同じ（出来事を足さない） */
export interface WishDraft { wish: DirectiveWish; label: string; kind: string | null; appearanceId: string | null; same: boolean }

/** 門の結果: 断り（wish があれば、希望として覚えてから断る） */
export interface GateRefusal { error: ActionError; wish?: WishDraft }

/**
 * プレイヤーの口から来た、握られた項目の命令を、希望の形にする（成り立たなければ null: 候補に無い・その品を持っていない など。そのときは希望を覚えずに断る）
 */
function wishFor(world: World, content: Content, pr: PlayerRecord, cmd: Command, reason: string | undefined): WishDraft | null {
  const L = pr.locale;
  const me = world.entities[pr.entityId];
  if (!me) return null;
  const cur = pr.directive?.wishes ?? [];
  const r = reason ? { reason } : {};
  const done = (wish: DirectiveWish, kind: string | null = null, appearanceId: string | null = null): WishDraft => {
    const known = !kind || !content.items[kind]?.unidentified || pr.knowledge.identified.includes(kind);
    return { wish, label: wishLabel(L, content, wish, kind || appearanceId ? { kind: known ? kind : null, appearanceId } : null), kind, appearanceId, same: sameWish(cur.find((x) => x.item === wish.item), wish) };
  };
  switch (cmd.type) {
    case 'start_expedition': {
      const camp = world.camp;
      if (pr.state !== 'at_camp' || !camp) return null;
      if (cmd.offer === 'endless') return done({ item: 'objective', no: camp.nextNo, offer: 'endless', objective: { type: 'endless', targetDepth: null }, ...r });
      const o = camp.offers.find((x) => x.index === cmd.offer);
      return o ? done({ item: 'objective', no: camp.nextNo, offer: o.index, objective: { ...o.objective }, ...r }) : null;
    }
    case 'equip': {
      const id = (me.inv?.items ?? []).find((x) => world.entities[x]?.item?.slot === cmd.slot);
      const it = id ? world.entities[id] : undefined;
      if (!it || !content.items[it.kind]?.equip || Object.values(me.equip ?? {}).includes(it.id)) return null;
      return done({ item: 'loadout', act: 'equip', target: it.id, ...r }, it.kind, world.secret.appearances[it.kind] ?? null);
    }
    case 'unequip': {
      let id: string | undefined;
      if ((EQUIP_SLOTS as readonly string[]).includes(cmd.slot)) id = me.equip?.[cmd.slot as EquipSlot] ?? undefined;
      else {
        const x = (me.inv?.items ?? []).find((y) => world.entities[y]?.item?.slot === cmd.slot);
        id = x && Object.values(me.equip ?? {}).includes(x) ? x : undefined;
      }
      const it = id ? world.entities[id] : undefined;
      if (!it) return null;
      return done({ item: 'loadout', act: 'unequip', target: it.id, ...r }, it.kind, world.secret.appearances[it.kind] ?? null);
    }
    case 'choose_perk': {
      const offer = me.build?.pending[0];
      if (!offer?.options.length) return null;
      const id = typeof cmd.option === 'number' ? offer.options[cmd.option - 1]
        : offer.options.find((o) => o === cmd.option || o.split(':')[1] === cmd.option || o.replace(/^[^:]+:perk_/, '') === cmd.option);
      return id ? done({ item: 'perk', perk: id, level: offer.level, ...r }) : null;
    }
    case 'choose_boon': {
      const ch = me.boonChoice;
      if (!ch?.options.length) return null;
      const id = typeof cmd.option === 'number' ? ch.options[cmd.option - 1]
        : ch.options.find((o) => o === cmd.option || o.split(':')[1] === cmd.option || o.replace(/^[^:]+:boon_/, '') === cmd.option);
      return id ? done({ item: 'boon', boon: id, depth: ch.depth, ...r }) : null;
    }
    default:
      return null;
  }
}

/**
 * 指図の門（engine の step の初め）: 断るならその断り（wish があれば、希望として覚えてから断る。それ以外は出来事を出さない）。通すなら null。
 * owner: 命令が持ち主の口から来た（記録の source: owner）。thought: 命令に付いた考え（希望の理由。記録に残るので、再生でも同じ）
 */
export function directiveGate(world: World, content: Content, pr: PlayerRecord, cmd: Command, owner: boolean, thought?: string): GateRefusal | null {
  const L = pr.locale;
  const d = pr.directive;
  const hold = d?.hold ?? [];
  const atCamp = pr.state === 'at_camp' && world.status !== 'ended';
  if (cmd.type === 'set_directive' || cmd.type === 'prepare') {
    if (!owner) {
      return { error: cmd.type === 'set_directive'
        ? actionError('bad_request', t(L, 'set_directive は持ち主の口からだけ（人間の画面の、持ち主の枠）。プレイヤーの命令ではない。', 'set_directive comes only from the owner (the owner panel in the browser). It is not a player command.'), '')
        : actionError('bad_request', t(L, 'prepare は持ち主の口からだけ（人間の画面の、持ち主の枠の「準備完了」）。プレイヤーの命令ではない。', 'prepare comes only from the owner (the "Ready" button in the owner panel). It is not a player command.'), '') };
    }
    if (!directiveTarget(world, pr)) return { error: actionError('bad_request', t(L, '指図は、ソロで、人間が自分で遊んでいないランだけ。', 'Directives apply only to solo runs not played by a human.'), '') };
    if (!atCamp) return { error: actionError('not_at_camp', t(L, '指図と支度は、キャンプでだけ変えられる（遠征の途中は、見守る）。', 'Directives and preparations can be changed only at camp (during an expedition, you watch).'), t(L, 'AI がキャンプに戻ってから。', 'Wait until your AI is back at camp.')) };
    if (cmd.type === 'prepare' && !hold.length) return { error: actionError('bad_request', t(L, '握っている項目が無いので、支度は無い（AI が待たずに出発する）。', 'Nothing is held, so there are no preparations (the AI sets out without waiting).'), t(L, '握るには set_directive { hold }。', 'Hold an item with set_directive { hold }.')) };
    return null;
  }
  const item = heldItemOf(cmd);
  if (owner) {
    // 遠征を始めるのは、いつもプレイヤー（S9 §58.1。§54.3 の表の 1 行目を改めた）
    if (cmd.type === 'start_expedition') {
      return { error: actionError('bad_request', t(L, '遠征を始めるのは、プレイヤー。目的を選んで（prepare { objective }）、準備完了を出す（prepare { ready: true }）。AI が来たら、出発する。', 'Expeditions are started by the player. Choose the objective (prepare { objective }) and mark the preparations ready (prepare { ready: true }); the AI sets out when it comes.'),
        t(L, 'AI に、声をかける。', 'Let your AI know.')) };
    }
    if (!item || !hold.includes(item)) {
      const held = hold.map((x) => directiveItemName(L, x)).join(t(L, '・', ', ')) || t(L, 'なし', 'none');
      return { error: actionError('bad_request', t(L, `持ち主の口から出せるのは、set_directive・prepare と、握った項目の命令だけ（いま握っている: ${held}）。`, `From the owner you can send set_directive, prepare and the commands of the items you hold only (held now: ${held}).`), t(L, '握るには set_directive { hold }。', 'Hold an item with set_directive { hold }.')) };
    }
    if (!atCamp) return { error: actionError('not_at_camp', t(L, '持ち主が決めるのは、キャンプでだけ（遠征の途中は、見守る）。', 'The owner decides only at camp (during an expedition, you watch).'), t(L, 'AI がキャンプに戻ってから。', 'Wait until your AI is back at camp.')) };
    return null;
  }
  const state = prepStateOf(d);
  const reason = wishReason(cleanDirectiveMessage, thought);
  // シーズンの予算を使い切った・終わりの時刻を過ぎたキャンプ: 支度を待たない（step の今の断り budget_exhausted・season_ended に任せる。S8b と同じ考え）
  const seasonClosed = !!world.season && ((seasonBudgetLeft(world, pr.id) ?? 1) <= 0 || world.season.ended);
  if (cmd.type === 'start_expedition' && atCamp && seasonClosed) return null;
  if (cmd.type === 'start_expedition') {
    if (hold.includes('objective')) {
      // 準備完了: 持ち主が選んだ目的で始める（step が offer を差し替える）
      if (atCamp && state === 'ready' && d?.prep?.objective !== undefined) return null;
      const pending = atCamp ? pendingText(L, prepNeedsWorld(world, content, pr, hold, d?.prep)) : null;
      const w = atCamp ? wishFor(world, content, pr, cmd, reason) : null;
      if (w) return { error: wishError(L, w.label, 'objective', false, pending), wish: w };
      const e = heldError(L, 'objective', !atCamp);
      if (pending) e.message += t(L, `持ち主の支度は、まだ（${pending}）。`, ` Your owner's preparations are not ready yet (${pending}).`);
      return { error: e };
    }
    // 目的は握られていないが、支度が「まだ」（S9 §58.1）
    if (atCamp && state === 'pending') {
      const pending = pendingText(L, prepNeedsWorld(world, content, pr, hold, d?.prep));
      return { error: actionError('held_by_owner', t(L, `持ち主の支度が、まだ（${pending}）。準備完了になるまで、start_expedition は断られる。`, `Your owner's preparations are not ready (${pending}). Until they are, start_expedition is refused.`), prepWaitHint(L)) };
    }
    return null;
  }
  if (item && hold.includes(item)) {
    const inDungeon = pr.state === 'alive';
    const w = wishFor(world, content, pr, cmd, reason);
    return w ? { error: wishError(L, w.label, item, inDungeon, null), wish: w } : { error: heldError(L, item, inDungeon) };
  }
  // 装備を握っている遠征の間は、装備中の品を捨てられない（付け替えに数える。§54.3「遠征の間は、だれも付け替えられない」）
  if (cmd.type === 'drop' && hold.includes('loadout') && pr.state === 'alive' && equippedSlot(world, pr, cmd.slot)) return { error: heldError(L, 'loadout', true) };
  return null;
}

/** 断るかどうかだけ（出来事は作らない。RunSession が、シーズンの取り込みを記録する前に確かめる） */
export function directiveRefusal(world: World, content: Content, pr: PlayerRecord, cmd: Command, owner: boolean): ActionError | null {
  return directiveGate(world, content, pr, cmd, owner)?.error ?? null;
}

/** 希望を覚える（S9 §58.2。門が wish を返したとき。同じ希望のくり返しは出さない） */
export function emitWish(ctx: Ctx, pr: PlayerRecord, w: WishDraft): void {
  if (w.same) return;
  const cur = pr.directive ?? { hold: [], message: '' };
  const after = directiveOf([...cur.hold], cur.message, cur.prep ? structuredClone(cur.prep) : undefined, putWish(cur.wishes, w.wish).map((x) => structuredClone(x)));
  ctx.emit({ type: 'directive_wish', player: pr.id, wish: structuredClone(w.wish), ...(w.wish.item === 'loadout' ? { kind: w.kind, appearanceId: w.appearanceId } : {}), directiveAfter: after, seenBy: [pr.id], floor: null });
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

/**
 * set_directive（門を通った後）: 変わっていなければ断る（出来事を出さない）。
 * 支度の札（S9 §58.1）: 握る項目を変えたら「まだ」に戻す（目的の選択は、目的を握り続けていれば残す）。初めて握ったら、決めるものが無ければ準備完了。
 * 握るのをすべてやめたら、札は消える。握るのをやめた項目の希望は消える
 */
export function setDirective(ctx: Ctx, pr: PlayerRecord, cmd: Extract<Command, { type: 'set_directive' }>): ActionError | null {
  const hold = DIRECTIVE_ITEMS.filter((x) => cmd.hold.includes(x));
  const message = cleanDirectiveMessage(cmd.message ?? '');
  // 長さは、制御文字などを落とした後の文字数で数える（S8a §55.6 の 10）
  if (message.length > DIRECTIVE_MESSAGE_MAX) return actionError('bad_request', t(pr.locale, `伝言は ${DIRECTIVE_MESSAGE_MAX} 字まで（いま ${message.length} 字）。`, `A message is up to ${DIRECTIVE_MESSAGE_MAX} characters (now ${message.length}).`), '');
  const cur = pr.directive ?? { hold: [], message: '' };
  if (cur.hold.join(',') === hold.join(',') && cur.message === message) {
    return actionError('nothing_to_do', t(pr.locale, '指図は変わっていない。', 'The directive is unchanged.'), '');
  }
  const w = ctx.world;
  const holdChanged = cur.hold.join(',') !== hold.join(',');
  let prep: DirectivePrep | undefined;
  if (!hold.length) prep = undefined;
  else if (!holdChanged) prep = cur.prep ? structuredClone(cur.prep) : undefined;
  else if (cur.hold.length) {
    // 握る項目を変えた: 「まだ」に戻す（S8 の版の記録で札が無ければ、今の持ち物から覚え始める）
    const keep = hold.includes('objective') && cur.prep?.objective !== undefined ? { objective: cur.prep.objective } : {};
    prep = { state: 'pending', ...keep, seen: cur.prep ? [...cur.prep.seen] : invIds(w, pr) };
  } else prep = freshPrep(w, ctx.content, pr, hold);
  const wishes = (cur.wishes ?? []).filter((x) => hold.includes(wishHeld(x.item))).map((x) => structuredClone(x));
  ctx.emit({ type: 'directive_set', player: pr.id, directiveAfter: directiveOf(hold, message, prep, wishes), seenBy: [pr.id], floor: null });
  return null;
}

/**
 * prepare（S9 §58.1。門を通った後: 持ち主の口・キャンプ・握っている項目がある）: 目的を選ぶ・準備完了・「まだ」に戻す。変わらなければ断る（出来事を出さない）。
 * 目的を選び直すと「まだ」に戻る（同じ命令で ready: true なら、そのまま準備完了）。目的を握っていれば、選ぶまで準備完了にできない
 */
export function prepare(ctx: Ctx, pr: PlayerRecord, cmd: Extract<Command, { type: 'prepare' }>): ActionError | null {
  const L = pr.locale;
  const w = ctx.world;
  const cur = pr.directive!;
  const hold = cur.hold;
  if (cmd.objective === undefined && cmd.ready === undefined) return actionError('bad_request', t(L, 'prepare には objective か ready が要る。', 'prepare needs objective or ready.'), '{ objective: 1 } / { ready: true }');
  let prep: DirectivePrep = cur.prep ? structuredClone(cur.prep) : { state: 'pending', seen: invIds(w, pr) };
  let changed = !cur.prep;
  let wishes = cur.wishes ? cur.wishes.map((x) => structuredClone(x)) : undefined;
  if (cmd.objective !== undefined) {
    if (!hold.includes('objective')) return actionError('bad_request', t(L, '目的を握っていないので、持ち主は選ばない（AI が選ぶ）。', 'The objective is not held, so the owner does not choose it (the AI does).'), t(L, '握るには set_directive { hold }。', 'Hold it with set_directive { hold }.'));
    const camp = w.camp;
    if (!camp) return actionError('not_at_camp', t(L, '今は、次の遠征の候補が無い。', 'There are no expedition offers right now.'), '');
    if (cmd.objective !== 'endless' && !camp.offers.some((o) => o.index === cmd.objective)) return actionError('bad_request', t(L, `候補 ${cmd.objective} は無い。`, `There is no offer ${cmd.objective}.`), t(L, `objective は 1〜${camp.offers.length} か "endless"。`, `objective is 1-${camp.offers.length} or "endless".`));
    if (prep.objective !== cmd.objective) {
      prep = { state: 'pending', objective: cmd.objective, seen: prep.seen };
      changed = true;
    }
    // 持ち主が目的を決めたので、目的の希望は消える
    if (wishes?.some((x) => x.item === 'objective')) { wishes = wishes.filter((x) => x.item !== 'objective'); changed = true; }
  }
  if (cmd.ready === true) {
    if (hold.includes('objective') && prep.objective === undefined) {
      return actionError('objective_unchosen', t(L, '目的を握っているので、次の遠征の目的を選ぶまで、準備完了にできない。', 'The objective is held, so the preparations cannot be ready until you choose the next expedition.'), t(L, 'prepare { objective }（候補の番号か endless）で選んでから。', 'Choose one with prepare { objective } (an offer number or endless) first.'));
    }
    if (prep.state !== 'ready') {
      prep = { ...prep, state: 'ready', seen: invIds(w, pr) };
      changed = true;
    }
  } else if (cmd.ready === false && prep.state !== 'pending') {
    prep = { ...prep, state: 'pending' };
    changed = true;
  }
  if (!changed) return actionError('nothing_to_do', t(L, '支度は変わっていない。', 'The preparations are unchanged.'), '');
  // 並びを決める（同じ中身が同じ値になるように）
  const ordered: DirectivePrep = { state: prep.state, ...(prep.objective !== undefined ? { objective: prep.objective } : {}), seen: prep.seen };
  ctx.emit({ type: 'directive_prep', player: pr.id, why: 'owner', directiveAfter: directiveOf([...hold], cur.message, ordered, wishes), seenBy: [pr.id], floor: null });
  return null;
}

/**
 * 持ち主が、握った項目を決めた後（S9 §58.1・§58.2）: 準備完了だった札は「まだ」に戻し、その項目の希望を消す（変わらなければ何も出さない）
 */
export function afterOwnerDecision(ctx: Ctx, pid: string, items: readonly WishItem[]): void {
  const pr = ctx.world.players[pid];
  const cur = pr?.directive;
  if (!cur) return;
  const wishes = (cur.wishes ?? []).filter((x) => !items.includes(x.item));
  const prep = cur.prep?.state === 'ready' ? { ...structuredClone(cur.prep), state: 'pending' as const } : cur.prep ? structuredClone(cur.prep) : undefined;
  if (wishes.length === (cur.wishes ?? []).length && prep?.state === cur.prep?.state) return;
  const ordered = prep ? { state: prep.state, ...(prep.objective !== undefined ? { objective: prep.objective } : {}), seen: prep.seen } : undefined;
  ctx.emit({ type: 'directive_prep', player: pid, why: 'decided', directiveAfter: directiveOf([...cur.hold], cur.message, ordered, wishes.map((x) => structuredClone(x))), seenBy: [pid], floor: null });
}

/**
 * キャンプに着いた（S9 §58.1。候補を出した後に engine が呼ぶ）: 握っている項目のあるプレイヤーの札を置き直す。決めるものがあれば「まだ」、無ければ準備完了
 * （そのときは持ち物を覚え直す）。前のキャンプで選んだ目的は消える。変わらなければ何も出さない（握っていないランには、何も出ない）
 */
export function settleCampPrep(ctx: Ctx): void {
  const w = ctx.world;
  for (const pid of w.playerOrder) {
    const pr = w.players[pid];
    const cur = pr.directive;
    if (pr.state !== 'at_camp' || !cur?.hold.length || !directiveTarget(w, pr)) continue;
    const next = freshPrep(w, ctx.content, pr, cur.hold, cur.prep?.seen ?? invIds(w, pr));
    if (JSON.stringify(cur.prep ?? null) === JSON.stringify(next)) continue;
    ctx.emit({ type: 'directive_prep', player: pid, why: 'camp', directiveAfter: directiveOf([...cur.hold], cur.message, next, cur.wishes?.map((x) => structuredClone(x))), seenBy: [pid], floor: null });
  }
}

/** 準備完了のとき、プレイヤーの start_expedition が使う候補（S9 §58.1: 目的を握っていれば、持ち主が選んだもの。そうでなければ undefined） */
export function ownerObjective(pr: PlayerRecord): number | 'endless' | undefined {
  const d = pr.directive;
  return d?.hold.includes('objective') && d.prep?.state === 'ready' ? d.prep.objective : undefined;
}

/** 持ち主の口から握った項目を決めた（§54.6: 順位の印の元）。同じ命令の出来事の後に出す。S9: 目的は、プレイヤーが持ち主の選んだ目的で遠征を始めたとき（offer・asked） */
export function noteOwnerDecided(ctx: Ctx, pid: string, item: DirectiveItem, act: 'start_expedition' | 'equip' | 'unequip' | 'choose_perk' | 'choose_boon', extra: { no?: number; kind?: string | null; appearanceId?: string | null; choice?: string; offer?: number | 'endless'; asked?: number | 'endless' } = {}): void {
  const cur = ctx.world.players[pid]?.ownerDecided ?? [];
  const after = DIRECTIVE_ITEMS.filter((x) => x === item || cur.includes(x));
  ctx.emit({ type: 'owner_decided', player: pid, item, act, ...extra, decidedAfter: after, seenBy: [pid], floor: null });
}

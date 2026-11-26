// 支度の画面（S10。SEASON.md §58.4）の、上の状態と、段ごとの今の状態の 1 行。画面から離した関数（テストする）。
// 中身は、そのプレイヤーの PlayerView と観測（持ち主の口の …/owner/view）から取ったものだけ（持ち主に、プレイヤーより多くを見せない）。
import type { DirectiveItem, OwnerPace } from '@muse/shared';
import { DIRECTIVE_ITEMS } from '@muse/shared';
import { tr } from '../util';
import type { HubTone } from './hubState';

/** 画面の上の状態: human あなたが遊ぶ・watch 遠征の途中・closed 変えられない・free 全部任せている・pending 支度が「まだ」・ready 準備完了 */
export type PrepHeadKind = 'human' | 'watch' | 'closed' | 'free' | 'pending' | 'ready';

export interface PrepHeadInput {
  name: string;
  /** 指図を出せる冒険者か（人間が自分で遊ぶ冒険者は false） */
  eligible: boolean;
  status: 'at_camp' | 'in_dungeon' | 'ended';
  depth: number | null;
  hold: readonly DirectiveItem[];
  prep: 'pending' | 'ready' | null;
  /** シーズンの写し（シーズンのランだけ） */
  season: { budgetLeft: number; ended: boolean; final?: boolean } | null;
  /** このサーバーと違う版で始まった冒険（S10a。続きは遊べない） */
  oldVersion?: boolean;
}

export interface PrepHead {
  kind: PrepHeadKind;
  pill: { text: string; tone: HubTone };
  line: string;
  /** 決められる（キャンプにいて、変えられる） */
  editable: boolean;
}

/** 上の状態（ピルと 1 行）と、決められるか */
export function prepHead(x: PrepHeadInput): PrepHead {
  const n = x.name;
  if (!x.eligible) return { kind: 'human', editable: false, pill: { text: tr('あなたが遊ぶ', 'You play'), tone: 'muted' }, line: tr(`${n}は、あなたが自分で遊ぶ冒険者。支度は、遊ぶ画面のキャンプで決める`, `You play ${n} yourself. Prepare at camp on the play screen`) };
  if (x.oldVersion) return { kind: 'closed', editable: false, pill: { text: tr('前の版', 'Older version'), tone: 'muted' }, line: tr('前の版で始まった冒険。このサーバーでは、続きを遊べない（記録は、見返せる）', 'This adventure began on an older version. It cannot be continued on this server (its records can be looked back on)') };
  if (x.status === 'ended') return { kind: 'closed', editable: false, pill: { text: tr('終わった', 'Ended'), tone: 'muted' }, line: tr('この冒険は、終わった。記録は、見返せる', 'This adventure has ended. Its records can be looked back on') };
  if (x.season?.final) return { kind: 'closed', editable: false, pill: { text: tr('終わり', 'Done'), tone: 'muted' }, line: tr('このシーズンは終わった。記録は、見返せる', 'This season is over. Its records can be looked back on') };
  if (x.status !== 'at_camp') {
    return {
      kind: 'watch', editable: false,
      pill: { text: x.depth !== null ? tr(`迷宮の中・地下${x.depth}階`, `In the dungeon, depth ${x.depth}`) : tr('迷宮の中', 'In the dungeon'), tone: 'blue' },
      line: tr('遠征の途中は、見守る。支度は、キャンプに戻ってから', 'During an expedition, you watch. Preparations wait until camp'),
    };
  }
  if (x.season && x.season.budgetLeft <= 0) return { kind: 'closed', editable: false, pill: { text: tr('終わり', 'Done'), tone: 'muted' }, line: tr('このシーズンの手番を、使い切った。もう出発しない', 'All of this season\'s turns are used. No more expeditions') };
  if (x.season?.ended) return { kind: 'closed', editable: false, pill: { text: tr('終わり', 'Done'), tone: 'muted' }, line: tr('シーズンが終わった。新しい遠征は、始まらない', 'The season is over. No new expedition starts') };
  if (!x.hold.length) return { kind: 'free', editable: true, pill: { text: tr('任せている', 'Left to them'), tone: 'muted' }, line: tr(`全部、任せている。${n}は、自分で決めて出発する`, `Everything is left to ${n}, who decides and sets out on their own`) };
  if (x.prep === 'ready') return { kind: 'ready', editable: true, pill: { text: tr('準備完了', 'Ready'), tone: 'green' }, line: tr(`準備完了。${n}が来たら、出発する`, `Ready. ${n} sets out when they come`) };
  return { kind: 'pending', editable: true, pill: { text: tr('支度: まだ', 'Not ready'), tone: 'amber' }, line: tr(`${n}は、あなたの支度を待っている`, `${n} is waiting for your preparations`) };
}

/** 準備完了の後の窓（S12a。SEASON.md §63.2 の 2） */
export interface ReadyNudge {
  title: string;
  body: string;
  /** AI に渡す 1 文（写せる）。AI がもう待っているときは null */
  copy: string | null;
}

/** AI に渡す 1 文（S12a）。冒険者の名前は入れない（AI の側で、だれのことか分かる） */
export function readyNudgeCopy(): string {
  return tr('支度ができたよ。MuseDungeon の続きを遊んで。', 'I\'m ready. Please continue our MuseDungeon run.');
}

/**
 * 「準備完了」を押して通ったときに出す窓。出さないなら null。
 * 出すのは、押した（sent）・通った（ok）・押す前は準備完了でなく（before）、押した後に準備完了（after）のときだけ。
 * 決めるものが無くて最初から準備完了のキャンプ・「支度を見直す」・断られたときは、出さない。
 * aiWaiting: AI が、今、wait_for_turn で待っている（サーバーの ai.waitingNow。押す前か後のどちらかで true）
 */
export function readyNudge(x: { name: string; sent: boolean; ok: boolean; before: 'pending' | 'ready' | null; after: 'pending' | 'ready' | null; aiWaiting: boolean }): ReadyNudge | null {
  if (!x.sent || !x.ok || x.before === 'ready' || x.after !== 'ready') return null;
  const n = x.name;
  const title = tr(`${n}に、声をかける`, `Let ${n} know`);
  if (x.aiWaiting) return { title, body: tr(`${n}は、今、待っている。すぐに出発する`, `${n} is waiting right now and sets out at once`), copy: null };
  return {
    title,
    body: tr(`支度は済んだ。${n}が来たら、出発する。画面からは、${n}を呼べない。チャットなどで、遊ぶように伝える`, `The preparations are done. ${n} sets out when they come. This screen cannot call ${n}. Tell them to play, in a chat or the like`),
    copy: readyNudgeCopy(),
  };
}

/** 指図の中身（握る項目と伝言）。サーバーの今の値 */
export interface DirectiveNow { hold: readonly DirectiveItem[]; message: string }

/**
 * 「任せる／自分で」で送る指図（S10a §1）: 送る直前に読み直したサーバーの値（fresh）に、押した 1 つだけを足す・外す。伝言はサーバーの値のまま
 * （画面の古い値や書きかけで、ほかのタブの変更を上書きしない）。変わらなければ null（送らない）
 */
export function directiveToggle(fresh: DirectiveNow | null | undefined, item: DirectiveItem, on: boolean): { hold: DirectiveItem[]; message: string } | null {
  const cur = DIRECTIVE_ITEMS.filter((x) => (fresh?.hold ?? []).includes(x));
  if (cur.includes(item) === on) return null;
  const hold = on ? DIRECTIVE_ITEMS.filter((x) => cur.includes(x) || x === item) : cur.filter((x) => x !== item);
  return { hold, message: fresh?.message ?? '' };
}

/** 伝言を残すときに送る指図（S10a §1）: 握る項目は読み直したサーバーの値のまま、伝言だけ替える（280 字まで）。変わらなければ null */
export function messageSave(fresh: DirectiveNow | null | undefined, message: string, max = 280): { hold: DirectiveItem[]; message: string } | null {
  const hold = DIRECTIVE_ITEMS.filter((x) => (fresh?.hold ?? []).includes(x));
  const m = [...message].slice(0, max).join('');
  if (m === (fresh?.message ?? '')) return null;
  return { hold, message: m };
}

/**
 * 進め方の段（S14。SEASON.md §65.4 の 2）: 持ち主の希望。握る項目ではない（伝言と同じ扱い。札は戻らない。準備完了の間も変えられる）。
 * 段の今の状態の 1 行。pace が分からない（読み込み前・古いサーバー）ときは、既定（self）として書く
 */
export function paceLine(pace: OwnerPace | undefined, name: string): string {
  return pace === 'pilot'
    ? tr(`pilot で進めてほしい、と${name}に伝えている（希望）`, `You have asked ${name} to play with pilot (a wish)`)
    : tr(`${name}が、自分で考えて進む（既定）`, `${name} plays on their own (the default)`);
}

/** 進め方の段の補足（S14）。どう進めるかは、AI の側が決める */
export function paceNote(name: string): string {
  return tr(`希望として、${name}に伝わる。どう進めるかは、${name}の側が決める。pilot は、AI の側に置く道具（README）`,
    `It reaches ${name} as a wish. How to play is up to ${name}'s side. pilot is a tool kept on the AI's side (see the README)`);
}

/** 進め方を変えた後の 1 行（S14） */
export function paceSavedNote(pace: OwnerPace, name: string): string {
  return pace === 'pilot'
    ? tr(`pilot で進めてほしい、と${name}に伝える（キャンプの観測と、遠征を始めた直後の応答に出る）。`, `${name} will be asked to play with pilot (in the camp observation and right after an expedition starts).`)
    : tr(`${name}が、自分で考えて進む（何も伝えない）。`, `${name} plays on their own (nothing is passed on).`);
}

/** 段の名前 */
export function prepItemName(x: DirectiveItem): string {
  return x === 'objective' ? tr('目的', 'Objective') : x === 'loadout' ? tr('装備', 'Equipment') : tr('特技と加護', 'Perks and boons');
}

/** 段の「任せる」のときの補足（握ることの代価: SEASON.md §54.3） */
export function prepItemCost(x: DirectiveItem): string {
  return x === 'objective'
    ? tr('自分で選ぶと、目的を選んで「準備完了」を出すまで、出発しない。迷宮の中のことは、任せたまま', 'If you choose it, they wait until you pick one and mark ready. Everything inside the dungeon stays with them')
    : x === 'loadout'
      ? tr('自分で決めると、迷宮で手に入れた装備は、キャンプで確かめるまで身に着けない', 'If you decide it, gear found in the dungeon is not worn until it is looked over at camp')
      : tr('自分で選ぶと、遠征の間に覚えられることが増えても、身につけるのはキャンプに戻ってから', 'If you choose them, what they grow able to learn is taken up only back at camp');
}

export interface PrepLineInput {
  name: string;
  held: boolean;
  /** 選んだ目的の文（目的の段。選んでいなければ null） */
  chosen?: string | null;
  /** 身に着けている品の名前（武器・防具・装飾の順） */
  equipment?: readonly string[];
  /** 決めていない、新しく持ち物に入った装備の数 */
  gear?: number;
  /** 取った特技と、加護の名前 */
  perks?: readonly string[];
  boons?: readonly string[];
  perkPending?: { level: number; options: number } | null;
  boonPending?: { depth: number; options: number } | null;
}

/** 段の今の状態の 1 行（「（名前）が決める」「鎚矛・革の鎧」「特技なし ― Lv2 の候補 3 つを選んでいない」） */
export function prepLine(item: DirectiveItem, x: PrepLineInput): string {
  const who = tr(`${x.name}が決める`, `${x.name} decides`);
  if (item === 'objective') {
    if (!x.held) return who;
    return x.chosen ? tr(`選んだ: ${x.chosen}`, `Chosen: ${x.chosen}`) : tr('まだ選んでいない ― 候補から 1 つ選ぶ', 'Not chosen yet — pick one of the offers');
  }
  if (item === 'loadout') {
    const base = x.equipment?.length ? x.equipment.join(tr('・', ', ')) : tr('何も身に着けていない', 'Nothing worn');
    if (!x.held) return tr(`${base}（${who}）`, `${base} (${who})`);
    return x.gear ? tr(`${base} ― 新しく持ち物に入った装備 ${x.gear} 品を、まだ決めていない`, `${base} — ${x.gear} new piece${x.gear > 1 ? 's' : ''} of gear not decided yet`) : base;
  }
  // 特技と加護を分けて書く（S11: 「特技: 強打・鎧さばき ／ 加護: 執念」）
  const perks = x.perks?.length ? tr(`特技: ${x.perks.join('・')}`, `Perks: ${x.perks.join(', ')}`) : tr('特技なし', 'No perks');
  const base = x.boons?.length ? tr(`${perks} ／ 加護: ${x.boons.join('・')}`, `${perks} / Boons: ${x.boons.join(', ')}`) : perks;
  const pend = [
    x.perkPending ? tr(`Lv${x.perkPending.level} の候補 ${x.perkPending.options} つを選んでいない`, `the ${x.perkPending.options} Lv${x.perkPending.level} options not chosen`) : '',
    x.boonPending ? tr(`加護の候補 ${x.boonPending.options} つを選んでいない`, `the ${x.boonPending.options} boon options not chosen`) : '',
  ].filter(Boolean).join(tr('・', '; '));
  if (!x.held) return tr(`${base}（${who}）`, `${base} (${who})`);
  return pend ? tr(`${base} ― ${pend}`, `${base} — ${pend}`) : base;
}

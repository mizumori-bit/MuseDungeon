// 拠点・支度・「自分で潜る」の窓の断りの文（S10a §6）: サーバーの文（「プロフィールのトークン」「Authorization: Bearer …」など仕組みの言葉）を、
// 画面の言葉の文に置き換える。運用の画面は、今のまま（サーバーの文）。画面から離した関数（テストする）。
import { ApiError, errorText } from '../api';
import { inLocale, tr } from '../util';

/** 例外から、画面の言葉の文（置き換えないものは、サーバーの文の画面の言葉の側） */
export function screenErr(e: unknown): string {
  if (e instanceof ApiError) {
    const s = screenErrOf(e.status, e.error?.code, e.error?.message);
    if (s) return s;
    if (e.error) return `${inLocale(e.error.message)}${e.error.hint ? ` — ${inLocale(e.error.hint)}` : ''}`;
  }
  return errorText(e);
}

/**
 * 断りの状態と code（と、サーバーの文の日本語の側）から、画面の言葉の文。置き換えないものは null（呼ぶ側がサーバーの文を出す）。
 * 401 鍵が見つからない・403 鍵が無い・404 冒険が見つからない・run_ended・recovery_failed・season_unavailable（理由の言葉で分ける）・つながらない
 */
export function screenErrOf(status: number, code: string | null | undefined, message = ''): string | null {
  if (code === 'recovery_failed' || status === 503) return tr('この冒険は、サーバーの起動時に読み込めなかった（運用者に知らせる）', 'This adventure could not be loaded when the server started (tell the operator)');
  if (code === 'run_ended') return tr('この冒険は、終わった。記録で見返せる', 'This adventure has ended. Look it back up in the records');
  if (code === 'season_unavailable') {
    // サーバーの文（「招かれていない」）は変えない。画面では、札と同じ言い方に（S12a）
    if (message.includes('招かれていない')) return tr('この冒険者は、このシーズンの名簿に、まだ入っていない。このシーズンを開いた人に、加えてもらう', 'This adventurer is not on this season\'s roster yet. Ask whoever opened this season to add you');
    if (message.includes('使い切って')) return tr('このシーズンの手番を、使い切った', 'All of this season\'s turns are used');
    if (message.includes('終わっている')) return tr('このシーズンは、終わった', 'This season is over');
    if (message.includes('版')) return tr('このシーズンは、このサーバーと版が違う（運用者に知らせる）', 'This season is on a different version from this server (tell the operator)');
    if (message.includes('読めない')) return tr('このシーズンの記録が読めない（運用者に知らせる）', 'This season\'s records cannot be read (tell the operator)');
    return tr('このシーズンには、いま入れない（運用者に確かめる）', 'You cannot enter this season right now (check with the operator)');
  }
  if (status === 401) return tr('その鍵は、見つからない。運用者から受け取ったものか、確かめる', 'That key was not found. Check it is the one the operator gave you');
  if (status === 403) return tr('この冒険者の鍵が、このブラウザに無い。拠点で、鍵を入れる', 'This browser has no key for this adventurer. Enter the key on the hub');
  if (status === 404) return tr('この冒険者は、見つからない（冒険が終わったか、このサーバーに無い）', 'This adventurer was not found (the adventure ended, or it is not on this server)');
  if (status === 0) return tr('サーバーに、つながらない', 'Cannot reach the server');
  return null;
}

// 巻き戻し（リプレイ）を開けるか、開けないときの理由（S15。SEASON.md §68.2 の 6・§25.1）。画面から離した関数（テストする: test/replayGate.test.ts）。
// 開けるかの決まりは ui/replayRule.ts（サーバーの決まりを写したもの。そろっていることは tools/test/s15a.test.ts で確かめる）。ここは、断られたときの文
import { ApiError, errorText } from '../api';
import { tr } from '../util';

export { rewindAllowed, watchAllowed } from './replayRule';

/**
 * 巻き戻しの口が断ったときの、画面の言葉の文（置き換えないものは null: 呼ぶ側がサーバーの文を出す）。
 * season: そのランがシーズンのランか（meta から。分からなければ undefined）
 */
export function replayBlockedText(status: number, code: string | null | undefined, message = '', season?: string | null): string | null {
  if (code === 'season_unavailable') return tr('開催中のシーズンのランは、シーズンの結果が確定した後に見返せる（今は、拠点の「見守る」から、その場で見る）', 'Runs of a season in progress can be looked back on once the season is finalized (for now, watch live with "Watch" on the hub)');
  if (status === 403 && message.includes('after the run ends')) {
    return season
      ? tr('開催中のシーズンのランは、終わってから見返せる（今は、見守るだけ）', 'Runs of a season in progress can be looked back on once they end (for now, you can only watch)')
      : tr('このサーバーの設定では、ランが終わってから見返せる', 'On this server, a run can be looked back on once it ends');
  }
  if (status === 404) return tr('このランは、見つからない', 'This run was not found');
  return null;
}

/** 例外から、巻き戻しの画面に出す文 */
export function replayErrText(e: unknown, season?: string | null): string {
  if (e instanceof ApiError) {
    const s = replayBlockedText(e.status, e.error?.code, e.error?.message ?? '', season);
    if (s) return s;
  }
  return errorText(e);
}

/** 出来事を畳めなかった（版が古く、今の画面で読めない形）ときの文 */
export function oldVersionText(engineVersion: string | null | undefined): string {
  return engineVersion
    ? tr(`このランは、作られた版が古く、見返せない（engine ${engineVersion}）`, `This run was made by an old version and cannot be looked back on (engine ${engineVersion})`)
    : tr('このランは、作られた版が古く、見返せない', 'This run was made by an old version and cannot be looked back on');
}

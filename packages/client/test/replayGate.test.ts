// S15（SEASON.md §68.2 の 6・§25.1）: 巻き戻しを開けるか（画面のボタン）と、開けないときの理由の文。画面から離した関数（ui/replayGate.ts）
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { oldVersionText, replayBlockedText, replayErrText, rewindAllowed, watchAllowed } from '../src/ui/replayGate';
import { setLocale } from '../src/util';

afterEach(() => setLocale('ja'));

describe('S15 §68.2 の 6: who can rewind (the §25.1 rule, unchanged)', () => {
  it('a finalized season: anyone, also a run left at camp (not retired); before that: the same PC, ended runs only', () => {
    // 確定したシーズン: だれでも（キャンプにいるまま確定したランも）
    expect(rewindAllowed({ season: 's3', status: 'active', final: true, local: false })).toBe(true);
    expect(rewindAllowed({ season: 's3', status: 'ended', final: true, local: false })).toBe(true);
    // 開催中: 同じ PC から、終わったランだけ
    expect(rewindAllowed({ season: 's4', status: 'active', final: false, local: true })).toBe(false);
    expect(rewindAllowed({ season: 's4', status: 'ended', final: false, local: true })).toBe(true);
    expect(rewindAllowed({ season: 's4', status: 'ended', final: false, local: false })).toBe(false);
    // シーズンでないラン: サーバーの方針が follow_only なら、終わったランだけ
    expect(rewindAllowed({ season: null, status: 'active', final: false, local: false })).toBe(true);
    expect(rewindAllowed({ season: null, status: 'active', final: false, local: false, policy: 'follow_only' })).toBe(false);
    expect(rewindAllowed({ season: null, status: 'ended', final: false, local: false, policy: 'follow_only' })).toBe(true);
  });

  it('S15a: "Watch" on a refused replay only for those who can watch live (the season\'s watch list); unknown means no', () => {
    expect(watchAllowed({ season: null, runId: 'run_a', watchable: null })).toBe(true);
    expect(watchAllowed({ season: 's4', runId: 'run_a', watchable: ['run_a', 'run_b'] })).toBe(true);
    expect(watchAllowed({ season: 's4', runId: 'run_a', watchable: ['run_b'] })).toBe(false);
    expect(watchAllowed({ season: 's4', runId: 'run_a', watchable: [] })).toBe(false);
    expect(watchAllowed({ season: 's4', runId: 'run_a', watchable: null })).toBe(false);
  });

  it('a refusal is said in the screen\'s words; an old run that cannot be folded says so with its engine version', () => {
    const after = 'spectatorPolicy=follow_only: replay data is available after the run ends';
    expect(replayBlockedText(403, 'bad_request', after, 's4')).toBe('開催中のシーズンのランは、終わってから見返せる（今は、見守るだけ）');
    expect(replayBlockedText(403, 'bad_request', after, null)).toBe('このサーバーの設定では、ランが終わってから見返せる');
    expect(replayBlockedText(403, 'season_unavailable', '開催中の…', 's4')).toContain('シーズンの結果が確定した後に見返せる');
    expect(replayBlockedText(404, 'no_session', 'unknown run')).toBe('このランは、見つからない');
    expect(replayBlockedText(500, 'internal', 'x')).toBeNull();
    expect(replayErrText(new ApiError(after, 403, { code: 'bad_request', message: after, hint: '' } as never), 's4')).toBe('開催中のシーズンのランは、終わってから見返せる（今は、見守るだけ）');
    expect(oldVersionText('0.3.0')).toBe('このランは、作られた版が古く、見返せない（engine 0.3.0）');
    setLocale('en');
    expect(oldVersionText('0.3.0')).toBe('This run was made by an old version and cannot be looked back on (engine 0.3.0)');
  });
});

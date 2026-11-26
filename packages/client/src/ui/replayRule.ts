// 巻き戻し（リプレイ）と観戦を開けるかの決まり（S15・S15a。SEASON.md §25.1・§68.2 の 6）。画面の部品に頼らない関数だけ（サーバーのテストからも読む）。
// サーバーの決まりを写したもの（だれが何を見られるかは、サーバーが決める。画面は、開けないものにボタンを出さないだけ）:
//  - 巻き戻し: `packages/server/src/http/api.ts` の `spectatorBlocked`（`/api/runs/:id/events`・`keyframes`・`index`・`commands`・`summary` の前）。
//    確定する前のシーズンのランは、同じ PC から（`isLocalRequest`）だけ。シーズンのランと、方針 follow_only のサーバーは、終わったランだけ。
//    確定したシーズンのランは、終わったランと同じ（キャンプにいるまま確定したランも。S15）。
//    そろっていることは `packages/tools/test/s15a.test.ts` が、サーバーの口に同じ組み合わせを聞いて確かめる。
//  - 観戦: 開催中のシーズンのランは、そのランの持ち主の鍵か、同じ PC から（`GET /api/seasons/:id/watch` の `runs` が、そのとき観戦できるラン）。
import type { SpectatorPolicy } from '@muse/shared';

/**
 * 巻き戻しを開けるか。season: シーズンのランならシーズンの ID。final: そのシーズンが確定した。local: サーバーと同じ PC から開いている
 * （`GET /api/seasons/:id/watch` の `local`）。policy: サーバーの観戦の方針（`GET /api/config`。分からなければ省く）
 */
export function rewindAllowed(x: { season: string | null | undefined; status: 'active' | 'ended'; final: boolean; local: boolean; policy?: SpectatorPolicy | null }): boolean {
  if (x.season) {
    if (x.final) return true;
    return x.local && x.status === 'ended';
  }
  return x.policy !== 'follow_only' || x.status === 'ended';
}

/**
 * その場で観戦できるか（S15a: 巻き戻しを断られた画面の「見守る」）。シーズンでないランは、だれでも。シーズンのランは、
 * 観戦できるランの一覧（`GET /api/seasons/:id/watch` の `runs` の ID）に入っているときだけ。一覧が分からなければ（null）、出さない
 */
export function watchAllowed(x: { season: string | null | undefined; runId: string; watchable: readonly string[] | null }): boolean {
  if (!x.season) return true;
  return !!x.watchable && x.watchable.includes(x.runId);
}

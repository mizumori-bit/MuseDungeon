/* global console */
// 音のテーマ「hollow」の sound.json を書き出す。型（和音の分散・低音・打楽器）は同じ形の繰り返しが多いので、
// 手で JSON を書かずにここから作る。使い方: node docs/sound-audition/make-hollow.mjs
// 乱数は使わない。出力は毎回同じ。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'client', 'public', 'themes', 'hollow', 'sound.json');
const BEATS = 4;

// 和音。pad は上の 3 音、bass は根音・5 度・上の根音。度数だけで書くので、音階が替わっても成り立つ
// （I・VII・IV は 4 つの音階のどれでも三和音になる。III は light でだけ使う）。
const CH = {
  I:   { pad: [5, 8, 10], root: { degree: 1 },          fifth: { degree: 5 }, top: { degree: 8 } },
  VII: { pad: [4, 7, 9],  root: { degree: 7, oct: -1 }, fifth: { degree: 4 }, top: { degree: 7 } },
  IV:  { pad: [4, 6, 8],  root: { degree: 4 },          fifth: { degree: 8 }, top: { degree: 11 } },
  IV5: { pad: [4, 8, 11], root: { degree: 4 },          fifth: { degree: 8 }, top: { degree: 11 } },
  III: { pad: [5, 7, 10], root: { degree: 3 },          fifth: { degree: 7 }, top: { degree: 10 } },
};

/** 小節ごとに音を作る。fn(小節の番号, 和音) は [{ at（小節の中の拍）, ... }] を返す。 */
function bars(harmony, fn) {
  const notes = [];
  harmony.forEach((name, i) => {
    for (const n of fn(i, CH[name]) ?? []) notes.push({ ...n, at: i * BEATS + n.at });
  });
  return { bars: harmony.length, notes };
}
/** 旋律。小節ごとに [拍, 度数, 長さ, 追加] の並び。 */
function melody(barList, lvlOf = () => 1) {
  const notes = [];
  barList.forEach((b, i) => {
    for (const [at, degree, len, extra] of b) {
      const lvl = lvlOf(i);
      notes.push({ at: i * BEATS + at, degree, len, ...(lvl > 1 ? { lvl } : {}), ...(extra ?? {}) });
    }
  });
  return { bars: barList.length, notes };
}
/** 長い音（1.5 拍以上）に下のオクターブを重ねる。 */
const doubled = (barList) => barList.map((b) => b.map(([at, d, len, x]) => [at, len >= 1.5 ? [d - 7, d] : d, len, x]));
const hits = (list) => ({ bars: 1, notes: list.map(([at, hit, vel, lvl]) => ({ at, hit, vel, ...(lvl > 1 ? { lvl } : {}) })) });
const every8 = (hit, vel, lvl) => [0.5, 1.5, 2.5, 3.5].map((at) => [at, hit, vel, lvl]);
const every16 = (hit, vel, lvl) => [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75].map((at) => [at, hit, vel, lvl]);

const patterns = {};

// ---- キャンプ（聖域でも使う）: ゆっくりした分散和音と、歌う旋律 ----
const H_CAMP = ['I', 'IV', 'III', 'IV', 'I', 'IV', 'VII', 'I'];
patterns.bass_camp = bars(H_CAMP, (i, c) => [{ at: 0, ...c.root, len: 3.5 }]);
patterns.pad_camp = bars(H_CAMP, (i, c) => [
  { at: 0, degree: c.pad[0], len: 1, vel: 0.8 }, { at: 1, degree: c.pad[1], len: 1, vel: 0.7 },
  { at: 2, degree: c.pad[2], len: 1, vel: 0.8 }, { at: 3, degree: c.pad[1], len: 1, vel: 0.6 },
]);
patterns.lead_camp = melody([
  [[0, 5, 2], [2, 8, 2]],
  [[0, 6, 3], [3, 8, 1]],
  [[0, 7, 1], [1, 5, 1], [2, 3, 2]],
  [[0, 4, 1], [1, 6, 3]],
  [[2, 5, 1], [3, 8, 1]],
  [[0, 11, 2], [2, 8, 2]],
  [[0, 9, 1], [1, 7, 1], [2, 4, 1], [3, 5, 1]],
  [[0, 8, 4]],
], (i) => (i < 4 ? 1 : 2));

patterns.lead_sanct = melody([
  [],
  [[0, 8, 1], [1, 6, 1], [2, 4, 2]],
  [],
  [[0, 6, 1], [1, 8, 3]],
  [[0, 10, 2], [2, 8, 2]],
  [],
  [[0, 7, 1], [1, 9, 1], [2, 7, 2]],
  [[0, 5, 4]],
]);

// ---- 探索: 軽い歩み。低音は弾み、和音は分散、旋律は 16 小節で一巡（only で回ごとに変える） ----
const H_EXP = ['I', 'I', 'VII', 'IV', 'I', 'I', 'IV', 'VII'];
patterns.bass_explore = bars(H_EXP, (i, c) => [
  { at: 0, ...c.root, len: 1.5, vel: 0.9 },
  { at: 2, ...c.fifth, len: 1, vel: 0.7, lvl: 2 },
  ...(i % 2 === 1 ? [{ at: 3.5, ...c.root, len: 0.5, vel: 0.6, lvl: 2 }] : []),
]);
patterns.pad_explore = bars(H_EXP, (i, c) => {
  const [a, b, d] = c.pad;
  const shape = i % 2 === 0 ? [a, b, d, b] : [a, d, b, d];
  return [
    ...shape.map((degree, k) => ({ at: k, degree, len: 0.5, vel: k === 0 ? 0.8 : 0.65 })),
    { at: 1.5, degree: d, len: 0.5, vel: 0.45, lvl: 2 },
    ...(i % 4 === 3 ? [{ at: 3.5, degree: a, len: 0.5, vel: 0.45, lvl: 2 }] : []),
  ];
});
const E2a = { only: { every: 2, phase: 0 } }, E2b = { only: { every: 2, phase: 1 } }, E3 = { only: { every: 3, phase: 0 } };
patterns.lead_explore = melody([
  [[0, 5, 1], [1, 8, 1], [2, 7, 0.5], [2.5, 5, 1.5]],
  [[0, 3, 2]],
  [[0, 2, 1, E2a], [1, 4, 1, E2a], [2, 7, 2, E2a]],
  [[0, 6, 1.5], [1.5, 8, 0.5], [2, 6, 1], [3, 4, 1]],
  [],
  [[2, 5, 0.5, E2b], [2.5, 8, 0.5, E2b], [3, 10, 1, E2b]],
  [[0, 8, 1], [1, 6, 1], [2, 4, 2]],
  [[0, 2, 1, E3], [1, 4, 1, E3], [2, 5, 2, E3]],
  [],
  [[0, 5, 0.5], [0.5, 3, 0.5], [1, 1, 2]],
  [[2, 7, 1, E2b], [3, 9, 1, E2b]],
  [[0, 8, 2], [2, 6, 2]],
  [[0, 5, 1], [1, 8, 1], [2, 10, 1.5], [3.5, 9, 0.5]],
  [[0, 8, 3]],
  [],
  [[0, 4, 1, E2a], [1, 2, 1, E2a], [2, 7, 2, { ...E2a, oct: -1 }]],
], (i) => ([0, 1, 9, 12, 13].includes(i) ? 1 : 2));
patterns.perc_explore = hits([[1, 'high', 0.5], [3, 'high', 0.5], [2.5, 'high', 0.3, 2]]);

// ---- 警戒: 探索の和声のまま、低音が脈を打ち、和音が裏拍で刻む ----
patterns.bass_alert = bars(H_EXP, (i, c) => [0, 1, 2, 3].flatMap((b) => [
  { at: b, ...(b === 3 ? c.fifth : c.root), len: 0.4, vel: b === 0 ? 1 : 0.8 },
  { at: b + 0.5, ...c.root, len: 0.4, vel: 0.6, lvl: 2 },
]));
patterns.pad_alert = bars(H_EXP, (i, c) => [
  { at: 0.5, degree: c.pad, len: 0.4, vel: 0.8 },
  { at: 2.5, degree: c.pad, len: 0.4, vel: 0.8 },
  { at: 3.5, degree: c.pad, len: 0.4, vel: 0.6, lvl: 2 },
]);
patterns.lead_alert = melody([
  [[0, 8, 0.5], [0.5, 7, 0.5], [1, 5, 1]],
  [],
  [[0, 9, 0.5], [0.5, 7, 0.5], [1, 4, 1]],
  [],
  [[2, 5, 0.5], [2.5, 7, 0.5], [3, 8, 1]],
  [],
  [[0, 8, 0.5], [0.5, 6, 0.5], [1, 4, 1]],
  [[2, 4, 0.5], [2.5, 2, 0.5], [3, 2, 1]],
], (i) => (i < 4 ? 1 : 2));
patterns.perc_alert = hits([[0, 'low', 0.8], [2, 'low', 0.7], [1, 'high', 0.4], [3, 'high', 0.4],
  ...every8('high', 0.3, 2), [1.5, 'low', 0.55, 3], [3.5, 'mid', 0.45, 3], [2.75, 'low', 0.45, 3], ...every16('high', 0.2, 4)]);

// ---- 戦い: 8 分で走る低音、速い分散和音、動く旋律 ----
const H_CMB = ['I', 'I', 'IV5', 'VII'];
const M = [{ degree: 1 }, { degree: 5 }, { degree: 4 }, { degree: 3 }];
patterns.bass_combat = bars(H_CMB, (i, c) => (c === CH.I
  ? [M[0], c.root, M[1], c.root, M[2], c.root, M[3], c.root]
  : [c.root, c.root, c.fifth, c.root, c.top, c.root, c.fifth, c.root]).map((n, k) => (
  { at: k / 2, ...n, len: 0.4, vel: k % 2 === 0 ? 0.95 : 0.7, ...(k % 2 === 1 ? { lvl: 2 } : {}) })));
patterns.pad_combat = bars(H_CMB, (i, c) => {
  const [a, , d] = c.pad;
  return [
    ...[a, a, a, d, a, a, d, a].map((degree, k) => ({ at: k / 2, degree, len: 0.3, vel: [0, 3, 6].includes(k) ? 0.8 : 0.5, ...(k % 2 === 1 ? { lvl: 2 } : {}) })),
  ];
});
patterns.lead_combat = melody([
  [[0, 8, 0.5], [0.5, 12, 1], [1.5, 11, 0.5], [2, 10, 1.5], [3.5, 8, 0.5]],
  [[0, 12, 0.75], [0.75, 11, 0.75], [1.5, 10, 0.5], [2, 8, 2]],
  [[0, 8, 0.5], [0.5, 11, 1], [1.5, 10, 0.5], [2, 8, 1.5], [3.5, 7, 0.5]],
  [[0, 9, 0.75], [0.75, 11, 0.75], [1.5, 9, 0.5], [2, 7, 2]],
  [[0, 8, 0.5], [0.5, 12, 1], [1.5, 11, 0.5], [2, 10, 1], [3, 12, 0.5], [3.5, 14, 0.5]],
  [[0, 15, 1.5], [1.5, 14, 0.5], [2, 12, 2]],
  [[0, 11, 0.5], [0.5, 15, 1], [1.5, 12, 0.5], [2, 11, 1.5], [3.5, 8, 0.5]],
  [[0, 9, 0.75], [0.75, 7, 0.75], [1.5, 9, 0.5], [2, 11, 1], [3, 9, 1]],
], (i) => ([0, 1, 4, 5].includes(i) ? 1 : 2));
patterns.perc_combat = hits([[0, 'low', 1], [2, 'low', 0.9], [1, 'mid', 0.7], [3, 'mid', 0.7],
  ...every8('high', 0.35, 2), [1.5, 'low', 0.65, 3], [2.75, 'low', 0.55, 3], [3.5, 'mid', 0.5, 3], ...every16('high', 0.22, 4), [3.75, 'mid', 0.5, 4]]);

// ---- 守護者: 3+3+2 の重い刻み、長い音の旋律 ----
const H_GRD = ['I', 'IV5', 'VII', 'I'];
patterns.bass_guardian = bars(H_GRD, (i, c) => [
  { at: 0, ...c.root, len: 0.6 }, { at: 0.75, ...(c === CH.I ? M[1] : c.root), len: 0.6 }, { at: 1.5, ...(c === CH.I ? M[2] : c.root), len: 0.4 },
  { at: 2, ...c.root, len: 0.4, lvl: 2 }, { at: 2.5, ...(c === CH.I ? M[3] : c.root), len: 0.4 }, { at: 3, ...(c === CH.I ? c.root : c.fifth), len: 0.4 }, { at: 3.5, ...c.top, len: 0.4, lvl: 2 },
]);
patterns.pad_guardian = bars(H_GRD, (i, c) => [
  { at: 0, degree: c.pad, len: 0.3, vel: 0.9 }, { at: 0.75, degree: c.pad, len: 0.3, vel: 0.7 }, { at: 1.5, degree: c.pad, len: 0.75, vel: 0.8 },
  { at: 3, degree: c.pad, len: 0.5, vel: 0.6, lvl: 2 },
]);
patterns.lead_guardian = melody([
  [[0, 8, 0.75], [0.75, 12, 0.75], [1.5, 11, 0.5], [2, 10, 2]],
  [[0, 11, 0.75], [0.75, 8, 0.75], [1.5, 11, 0.5], [2, 12, 2]],
  [[0, 11, 0.75], [0.75, 9, 0.75], [1.5, 7, 0.5], [2, 9, 2]],
  [[0, 8, 0.75], [0.75, 10, 0.75], [1.5, 8, 0.5], [2, 5, 2]],
  [[0, 8, 0.75], [0.75, 12, 0.75], [1.5, 11, 0.5], [2, 10, 1], [3, 12, 1]],
  [[0, 15, 0.75], [0.75, 12, 0.75], [1.5, 11, 0.5], [2, 8, 2]],
  [[0, 9, 0.75], [0.75, 11, 0.75], [1.5, 14, 0.5], [2, 11, 1], [3, 9, 1]],
  [[0, 8, 3], [3, 5, 0.5], [3.5, 7, 0.5]],
], (i) => ([0, 3, 4, 7].includes(i) ? 1 : 2));
patterns.perc_guardian = hits([[0, 'low', 1], [1.5, 'low', 0.9], [1, 'mid', 0.7], [3, 'mid', 0.8],
  ...every8('high', 0.35, 2), [0.75, 'low', 0.7, 3], [3.5, 'low', 0.6, 3], [2.5, 'mid', 0.5, 3], ...every16('high', 0.22, 4), [3.75, 'mid', 0.5, 4]]);

// ---- 大守護者: 4 つ打ち、低音はオクターブで走り、和音は伸ばしと分散の両方、旋律は広く跳ぶ ----
const H_WRD = ['I', 'I', 'VII', 'VII', 'IV5', 'IV5', 'VII', 'VII'];
patterns.bass_warden = bars(H_WRD, (i, c) => (c === CH.I && i % 2 === 0
  ? [M[0], c.top, M[1], c.top, M[2], c.top, M[3], c.top]
  : [c.root, c.top, c.root, c.top, c.fifth, c.top, c.root, c.top]).map((n, k) => (
  { at: k / 2, ...n, len: 0.4, vel: k % 2 === 0 ? 1 : 0.75, ...(k % 2 === 1 ? { lvl: 2 } : {}) })));
patterns.pad_warden = bars(H_WRD, (i, c) => {
  const [a, b, d] = c.pad;
  return [
    { at: 0, degree: d, len: 1.2, vel: 0.7 },
    ...[a, a, a, b, a, a, b, a].map((degree, k) => ({ at: k / 2, degree, len: 0.3, vel: [0, 3, 6].includes(k) ? 0.65 : 0.45, lvl: 2 })),
  ];
});
patterns.lead_warden = melody(doubled([
  [[0, 8, 1.5], [1.5, 12, 2], [3.5, 11, 0.5]],
  [[0, 10, 3], [3, 8, 0.5], [3.5, 10, 0.5]],
  [[0, 11, 1.5], [1.5, 14, 2], [3.5, 11, 0.5]],
  [[0, 9, 3], [3, 7, 0.25], [3.25, 8, 0.25], [3.5, 9, 0.25], [3.75, 10, 0.25]],
  [[0, 11, 1.5], [1.5, 15, 2], [3.5, 12, 0.5]],
  [[0, 11, 2], [2, 8, 1], [3, 11, 1]],
  [[0, 14, 1.5], [1.5, 11, 0.5], [2, 9, 0.5], [2.5, 11, 0.5], [3, 14, 1]],
  [[0, 11, 0.75], [0.75, 9, 0.75], [1.5, 7, 0.5], [2, 9, 2]],
]), (i) => ([0, 1, 4, 5].includes(i) ? 1 : 2));
patterns.perc_warden = hits([[0, 'low', 1], [1, 'low', 0.9], [2, 'low', 1], [3, 'low', 0.9], [1, 'mid', 0.6], [3, 'mid', 0.7],
  ...every8('high', 0.4, 2), [0.5, 'low', 0.55, 3], [2.5, 'mid', 0.5, 3], [3.5, 'mid', 0.5, 3], ...every16('high', 0.22, 4), [3.75, 'mid', 0.5, 4]]);

// ---- 大守護者の間（まだ見えていないとき）: 和声が動かず、3 度のない和音と、主題の切れ端 ----
patterns.bass_hall = { bars: 1, notes: [
  { at: 0, degree: 1, len: 0.5 }, { at: 2, degree: 1, len: 0.5, vel: 0.8 },
  ...[0.5, 1, 1.5, 2.5, 3, 3.5].map((at) => ({ at, degree: at === 3.5 ? 8 : 1, len: 0.4, vel: 0.6, lvl: 2 })),
] };
patterns.pad_hall = { bars: 2, notes: [
  { at: 0, degree: 5, len: 1, vel: 0.7 }, { at: 1, degree: 8, len: 1, vel: 0.6 }, { at: 2, degree: 12, len: 2, vel: 0.7 },
  { at: 4, degree: 8, len: 1, vel: 0.6 }, { at: 5, degree: 5, len: 1, vel: 0.6 }, { at: 6, degree: 8, len: 2, vel: 0.6 },
] };
patterns.lead_hall = melody([
  [[0, 1, 1], [1, 8, 2]], [], [[0, 5, 1], [1, 10, 2]], [],
  [[0, 1, 1], [1, 8, 1.5], [2.5, 5, 0.5], [3, 10, 1]], [], [], [],
]);
patterns.perc_hall = hits([[0, 'low', 0.6], [2, 'low', 0.35, 2], [3, 'high', 0.3, 3], [1, 'high', 0.3, 4]]);

// ---- 気配: 高いところで鳴る小さな音。遠いときはまばら、近いと増える ----
patterns.glint = { bars: 2, notes: [
  { at: 1.5, degree: 5, len: 0.5, vel: 0.8 }, { at: 6.5, degree: 8, len: 0.5, vel: 0.7 },
  { at: 3.5, degree: 8, len: 0.5, vel: 0.7, lvl: 2 }, { at: 4.5, degree: 5, len: 0.5, vel: 0.8, lvl: 2 }, { at: 7.5, degree: 12, len: 0.5, vel: 0.7, lvl: 2 },
] };

// ---- 構え: 伸ばさない。吊った和音を短く 3 回 ----
patterns.pad_poise = { bars: 1, notes: [
  { at: 0, degree: [5, 8, 11], len: 0.3, vel: 0.8 }, { at: 1.5, degree: [5, 8, 11], len: 0.3, vel: 0.6 }, { at: 3, degree: [5, 8, 11], len: 0.3, vel: 0.5 },
] };

// ---- 終わり: ゆっくりした分散和音だけ ----
patterns.pad_ended = { bars: 4, notes: [
  { at: 0, degree: 5, len: 2, vel: 0.7 }, { at: 2, degree: 8, len: 2, vel: 0.6 }, { at: 4, degree: 10, len: 4, vel: 0.7 },
  { at: 8, degree: 8, len: 2, vel: 0.6 }, { at: 10, degree: 5, len: 2, vel: 0.6 }, { at: 12, degree: 8, len: 3, vel: 0.5 },
] };

for (const k of ['lead_combat', 'lead_guardian', 'lead_warden']) delete patterns[k]; // 第 6 版: 戦いでは旋律を鳴らさない

const all = (pfx, d = {}) => ({
  bass: { on: true, pattern: `bass_${pfx}`, density: d.bass ?? 2 },
  pad:  { on: true, pattern: `pad_${pfx}`, density: d.pad ?? 2 },
  lead: { on: true, pattern: `lead_${pfx}`, density: d.lead ?? 2 },
  perc: { on: true, pattern: `perc_${pfx}`, density: d.perc ?? 2 },
});
const SOFT = { wave: 'square', attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.18 };

const def = {
  id: 'hollow',
  formatVersion: 1,
  tempo: { bpm: 96, beats: BEATS },
  quantize: 'beat',
  fade: 0.4,
  scales: {
    light: { root: 'D3',  steps: [0, 2, 3, 5, 7, 9, 10] },
    dusk:  { root: 'C3',  steps: [0, 2, 3, 5, 7, 8, 10] },
    deep:  { root: 'B2',  steps: [0, 1, 3, 5, 7, 8, 10] },
    abyss: { root: 'Bb2', steps: [0, 1, 4, 5, 7, 8, 10] },
    // 地下 20 階より深い階（depth_tier 4 以上）は、暗い旋法のまま基音を移して 4 つを巡る
    abyss_b: { root: 'C#3', steps: [0, 1, 3, 5, 7, 8, 10] },
    abyss_c: { root: 'B2',  steps: [0, 1, 4, 5, 7, 8, 10] },
    abyss_d: { root: 'D3',  steps: [0, 1, 3, 5, 7, 8, 10] },
  },
  parts: [
    { id: 'bass', role: 'bass', octave: -1, gain: 0.2,
      voice: { wave: 'triangle', attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.12 } },
    { id: 'pad', role: 'chord', octave: 0, gain: 0.16,
      voice: { wave: 'square', lowpass: 900, attack: 0.01, decay: 0.25, sustain: 0.35, release: 0.2 } },
    { id: 'lead', role: 'lead', octave: 1, gain: 0.13,
      voice: { ...SOFT, lowpass: 1500 } },
    { id: 'glint', role: 'accent', octave: 2, gain: 0.1,
      voice: { wave: 'triangle', attack: 0.005, decay: 0.3, sustain: 0.2, release: 0.25 } },
    { id: 'perc', role: 'percussion', gain: 0.3,
      kit: {
        low:  { wave: 'sine', freq: 90, attack: 0.002, decay: 0.14 },
        mid:  { wave: 'noise', highpass: 1500, lowpass: 5000, attack: 0.001, decay: 0.09 },
        high: { wave: 'noise', highpass: 6000, attack: 0.001, decay: 0.04 },
      } },
  ],
  patterns,
  rules: [
    { when: {}, set: { scale: 'light', tempo: 1 } },
    { when: { depth_band: 1 }, set: { scale: 'dusk' } },
    { when: { depth_band: 2 }, set: { scale: 'deep' } },
    { when: { depth_band: 3 }, set: { scale: 'abyss' } },
    { when: { depth_tier: { min: 4, mod: 4, rem: 0 } }, set: { scale: 'abyss_b' } },
    { when: { depth_tier: { min: 4, mod: 4, rem: 1 } }, set: { scale: 'abyss_c' } },
    { when: { depth_tier: { min: 4, mod: 4, rem: 2 } }, set: { scale: 'abyss_d' } },

    // バイオーム: 音色だけを変える。石の広間・none・知らない ID は基準の音色のまま
    { when: { biome: 'core:damp_caves' }, set: { parts: { pad: { voice: { lowpass: 700, release: 0.3 } }, lead: { voice: { release: 0.3 } } } } },
    { when: { biome: 'core:overgrown_ruins' }, set: { parts: { lead: { voice: { wave: 'triangle' }, gain: 1.5 }, pad: { voice: { lowpass: 1100 } } } } },
    { when: { biome: 'core:sunken_archive' }, set: { parts: { pad: { voice: { wave: 'triangle' }, gain: 1.6 }, lead: { voice: { lowpass: 1000, attack: 0.03 } } } } },

    { when: { scene: 'camp' }, set: { scale: 'light', tempo: 0.8,
      parts: { ...all('camp'), perc: { on: false } } } },
    { when: { scene: 'explore' }, set: { parts: all('explore', { perc: 1 }) } },
    { when: { scene: 'alert' }, set: { tempo: 1.1, parts: all('alert', { bass: 1, perc: 1 }) } },
    { when: { scene: 'combat' }, set: { tempo: 1.3, parts: { ...all('combat', { bass: 1 }), bass: { on: true, pattern: 'bass_combat', density: 1, gain: 1.4 }, pad: { on: true, pattern: 'pad_combat', density: 2, gain: 1.4 }, lead: { on: false } } } },
    { when: { scene: 'guardian' }, set: { tempo: 1.4, parts: { ...all('guardian', { bass: 1 }), bass: { on: true, pattern: 'bass_guardian', density: 1, gain: 1.5 }, pad: { on: true, pattern: 'pad_guardian', density: 2, gain: 1.3 }, lead: { on: false } } } },
    { when: { scene: 'warden' }, set: { tempo: 1.5, parts: { ...all('warden', { bass: 1 }), bass: { on: true, pattern: 'bass_warden', density: 1, gain: 1.6 }, pad: { on: true, pattern: 'pad_warden', density: 2, gain: 1.5 }, lead: { on: false } } } },
    { when: { scene: 'ended' }, set: { tempo: 0.75, parts: {
      bass: { on: false }, pad: { on: true, pattern: 'pad_ended', density: 2, gain: 1.6 }, lead: { on: false }, perc: { on: false } } } },

    // 警戒は、どの階の種類でもその階の探索の曲のまま速くする（standard 1.0 → 1.1、sanctuary・warden_hall は 0.9 → 1.05。1.1 倍では気づきにくかったため）
    { when: { floor_kind: 'sanctuary', scene: ['explore', 'alert'] }, set: { scale: 'light', tempo: 0.9,
      parts: { ...all('camp'), bass: { on: false }, lead: { on: true, pattern: 'lead_sanct', density: 2, octave: 1 }, perc: { on: false } } } },
    { when: { floor_kind: 'sanctuary', scene: 'alert' }, set: { tempo: 1.05,
      parts: { bass: { on: true, pattern: 'bass_camp', density: 2 }, perc: { on: true, pattern: 'perc_hall', density: 1 } } } },
    { when: { floor_kind: 'warden_hall', scene: ['explore', 'alert'] }, set: { tempo: 0.9,
      parts: all('hall', { perc: 1, bass: 1 }) } },
    { when: { floor_kind: 'warden_hall', scene: 'alert' }, set: { tempo: 1.05, parts: { bass: { density: 2 } } } },

    { when: { threat: 0 }, set: { parts: { perc: { density: 1 } } } },
    { when: { threat: 1 }, set: { parts: { perc: { density: 2 } } } },
    { when: { threat: 2 }, set: { parts: { perc: { density: 3 }, bass: { density: 2 } } } },
    { when: { threat: 3 }, set: { parts: { perc: { density: 4 }, bass: { density: 2 } } } },

    { when: { hp: 'wounded' }, set: { parts: { pad: { density: 1, gain: 0.7 } } } },
    { when: { hp: 'badly_wounded' }, set: { parts: { lead: { octave: -1 }, pad: { density: 1, gain: 0.4 } } } },
    { when: { hp: 'near_death' }, set: { parts: {
      lead: { octave: -1, density: 1 }, pad: { on: false }, perc: { density: 1 }, bass: { density: 1 } } } },

    { when: { telegraph: true }, set: { parts: { lead: { on: false }, pad: { pattern: 'pad_poise' } } } },

    { when: { sense: 'far' }, set: { parts: { glint: { on: true, pattern: 'glint', density: 1 } } } },
    { when: { sense: 'near' }, set: { parts: { glint: { on: true, pattern: 'glint', density: 2, gain: 1.4 } } } },
  ],
  cues: {
    hit_taken: { start: 'now', gain: 0.35, octave: -1,
      voice: { wave: 'triangle', attack: 0.003, decay: 0.16, sustain: 0, release: 0.05 },
      notes: [{ at: 0, degree: 1, len: 0.18 }, { at: 0, hit: 'low' }] },
    crit_dealt: { start: 'now', gain: 0.24, octave: 1,
      voice: { wave: 'square', lowpass: 2600, attack: 0.002, decay: 0.12, sustain: 0.2, release: 0.1 },
      notes: [{ at: 0, hit: 'mid' }, { at: 0, degree: 8, len: 0.07 }, { at: 0.07, degree: 12, len: 0.18 }, { at: 0.07, hit: 'high' }] },
    crit_taken: { start: 'now', gain: 0.36, octave: -1,
      voice: { wave: 'triangle', attack: 0.003, decay: 0.2, sustain: 0.2, release: 0.1 },
      notes: [{ at: 0, hit: 'low' }, { at: 0, hit: 'mid' }, { at: 0, degree: 5, len: 0.1 }, { at: 0.1, degree: 1, len: 0.25 }] },
    kill: { start: 'now', gain: 0.32, octave: 1,
      voice: { wave: 'triangle', attack: 0.003, decay: 0.2, sustain: 0.3, release: 0.2 },
      notes: [{ at: 0, degree: 3, len: 0.12 }, { at: 0.12, degree: 1, len: 0.35 }] },
    level_up: { start: 'beat', gain: 0.22, octave: 1,
      voice: { wave: 'square', lowpass: 2400, attack: 0.003, decay: 0.15, sustain: 0.4, release: 0.25 },
      notes: [{ at: 0, degree: 1, len: 0.1 }, { at: 0.1, degree: 3, len: 0.1 }, { at: 0.2, degree: 5, len: 0.1 }, { at: 0.3, degree: 8, len: 0.6 }] },
    objective: { start: 'beat', gain: 0.3, octave: 1,
      voice: { wave: 'triangle', attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.3 },
      notes: [{ at: 0, degree: 5, len: 0.2 }, { at: 0.2, degree: 8, len: 0.3 }, { at: 0.5, degree: [1, 5], len: 0.7 }] },
    death: { start: 'now', gain: 0.3, octave: 0,
      voice: { wave: 'triangle', attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.25 },
      notes: [{ at: 0, degree: 5, len: 0.3 }, { at: 0.3, degree: 4, len: 0.3 }, { at: 0.6, degree: 3, len: 0.3 }, { at: 0.9, degree: 1, oct: -1, len: 0.35 }] },
  },
};

// 読みやすい JSON にする（音は 1 行に 1 つ）。
const one = (v) => (Array.isArray(v) ? `[${v.map(one).join(', ')}]`
  : v !== null && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${one(x)}`).join(', ')} }`
  : JSON.stringify(v));
let text = JSON.stringify(def, (k, v) => ((k === 'notes' || k === 'rules') && Array.isArray(v) ? v.map((n) => `@@${one(n)}@@`) : (k === 'steps' || k === 'voice' || k === 'low' || k === 'mid' || k === 'high') ? `@@${one(v)}@@` : v), 2);
text = text.replace(/"@@(.*?)@@"/g, (m, s) => JSON.parse(`"${s}"`));
JSON.parse(text);
fs.writeFileSync(out, text + '\n');
console.log(`wrote ${out} (${Object.keys(patterns).length} patterns)`);

// 名前を整える（S12c。SEASON.md §63.7 の検査の 2）: 招くときの表示名・拠点で始めるシーズンの名前・冒険者（キャラクター）の名前は、すべてこの 1 つの関数で整える。
// 掃除（制御文字と見えない文字を落とす）→ NFKC → もう一度掃除 → 前後の空白を落とす → コードポイントで数える。長すぎる名前は切らずに断る。
// 対になっていないサロゲート（壊れた文字）と、空になった名前も断る。今ある記録の名前（s0〜s4 の招きなど）は、読むときには検査しない。新しく入るときだけ。

/** 名前の長さの上限（コードポイント） */
export const NAME_MAX = 32;

/**
 * 落とす文字: C0・C1 の制御文字・ソフトハイフン・合成用書記素結合子・アラビア文字の印・ハングルの埋め字（U+115F・U+1160・U+3164・U+FFA0）・
 * クメールの見えない母音・モンゴルの母音区切り・ゼロ幅と向きの指定・行と段落の区切り・単語結合子など（U+2060〜206F）・点字の空白・
 * 異体字セレクタ（U+FE00〜FE0F・U+E0100〜E01EF）・BOM・行間注釈・タグ文字（U+E0000〜E007F）
 */
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x2800, 0x2800], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff9, 0xfffb], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

export function invisibleChar(cp: number): boolean {
  return INVISIBLE.some(([a, b]) => cp >= a && cp <= b);
}

/** 対になっていないサロゲートがあるか（UTF-16 の符号単位で見る） */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

const scrub = (s: string) => [...s].filter((ch) => !invisibleChar(ch.codePointAt(0)!)).join('');

export type NameResult = { ok: true; name: string } | { ok: false; reason: 'not_string' | 'empty' | 'too_long' | 'broken'; message: string };

/** 名前を整える。max はコードポイントの数 */
export function normalizeName(raw: unknown, max = NAME_MAX): NameResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_string', message: '名前は文字列 / the name must be a string' };
  if (hasLoneSurrogate(raw)) return { ok: false, reason: 'broken', message: '名前に、壊れた文字（対になっていないサロゲート）がある / the name has a broken character (an unpaired surrogate)' };
  const name = scrub(scrub(raw).normalize('NFKC')).trim();
  if (!name) return { ok: false, reason: 'empty', message: '名前が空（見えない文字だけの名前は使えない） / the name is empty' };
  if ([...name].length > max) return { ok: false, reason: 'too_long', message: `名前は ${max} 字まで（字の形を整えた後で数える） / the name is up to ${max} characters (counted after normalizing)` };
  return { ok: true, name };
}

// Fitting text into a circle: whole words, each line no wider than the circle is at
// that line's height, as few lines as hold the text, an ellipsis for what is left out.
// Pure: the caller supplies the function that measures a string's width.

export type Measure = (text: string) => number;

export interface Fit {
  lines: string[];
  /** Some of the text didn't fit and ends in an ellipsis. */
  truncated: boolean;
}

const ELLIPSIS = "…";

/**
 * The width available to each line of a stack of lines centred in a circle. A line
 * is as wide as the circle is at the line's edge furthest from the centre, so its
 * corners stay inside.
 */
export function lineWidths(radius: number, heights: readonly number[]): number[] {
  const total = heights.reduce((a, b) => a + b, 0);
  let y = -total / 2;
  return heights.map(h => {
    const far = Math.max(Math.abs(y), Math.abs(y + h));
    y += h;
    return far >= radius ? 0 : 2 * Math.sqrt(radius * radius - far * far);
  });
}

/**
 * Put as many whole words on each line as fit, in order. Returns the lines and how
 * many words were placed. A line stays empty if the next word is too wide for it.
 */
export function fill(
  words: readonly string[], widths: readonly number[], measure: Measure, sep = " ",
): { lines: string[]; used: number } {
  const lines: string[] = [];
  let used = 0;
  for (const width of widths) {
    let line = "";
    while (used < words.length) {
      const next = line ? line + sep + words[used] : words[used];
      if (measure(next) > width) break;
      line = next;
      used++;
    }
    lines.push(line);
  }
  return { lines, used };
}

/**
 * Spread words that fit over exactly `widths.length` lines, none of them empty and
 * each about as full as the others, so the block sits in the middle of the circle.
 * Null if the words can't be spread that way.
 */
export function balance(
  words: readonly string[], widths: readonly number[], measure: Measure, sep = " ",
): string[] | null {
  const n = widths.length, m = words.length;
  if (m < n || n === 0) return null;
  // best[i][j]: least unevenness with the first j words on the first i lines.
  const best: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(-1));
  best[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = i; j <= m; j++) {
      for (let k = j - 1; k >= i - 1; k--) {
        if (best[i - 1][k] === Infinity) continue;
        const w = measure(words.slice(k, j).join(sep));
        if (w > widths[i - 1]) break; // a longer line won't fit either
        const slack = 1 - w / widths[i - 1];
        const cost = best[i - 1][k] + slack * slack;
        if (cost < best[i][j]) {
          best[i][j] = cost;
          from[i][j] = k;
        }
      }
    }
  }
  if (best[n][m] === Infinity) return null;
  const lines: string[] = [];
  for (let i = n, j = m; i > 0; i--) {
    const k = from[i][j];
    lines.unshift(words.slice(k, j).join(sep));
    j = k;
  }
  return lines;
}

/** The longest prefix of `word` that fits with an ellipsis after it. */
function clip(word: string, width: number, measure: Measure): string {
  const chars = [...word];
  for (let n = chars.length - 1; n > 0; n--) {
    const text = chars.slice(0, n).join("") + ELLIPSIS;
    if (measure(text) <= width) return text;
  }
  return measure(ELLIPSIS) <= width ? ELLIPSIS : "";
}

/**
 * End incomplete lines with an ellipsis: drop words from the last line until the
 * ellipsis fits; if that empties the line, carry on with the line above.
 */
function ellipsize(
  lines: string[], widths: readonly number[], measure: Measure, sep: string, firstWord: string,
): string[] {
  const out = [...lines];
  for (let i = out.length - 1; i >= 0; i--) {
    if (!out[i]) continue;
    const words = out[i].split(sep);
    while (words.length) {
      const text = words.join(sep) + ELLIPSIS;
      if (measure(text) <= widths[i]) {
        out[i] = text;
        return out;
      }
      words.pop();
    }
    out[i] = "";
  }
  // Not even one whole word fits anywhere: show the start of the first, on the widest line.
  let widest = 0;
  for (let i = 1; i < widths.length; i++) if (widths[i] > widths[widest]) widest = i;
  out[widest] = clip(firstWord, widths[widest], measure);
  return out;
}

function fitWords(
  words: readonly string[], candidates: readonly (readonly number[])[], measure: Measure, sep: string,
): Fit {
  if (!words.length) return { lines: [], truncated: false };
  let best: { lines: string[]; used: number; widths: readonly number[] } | null = null;
  for (const widths of candidates) {
    const res = fill(words, widths, measure, sep);
    if (res.used === words.length) {
      return { lines: balance(words, widths, measure, sep) ?? res.lines, truncated: false };
    }
    if (!best || res.used > best.used) best = { ...res, widths };
  }
  if (!best) return { lines: [], truncated: true };
  return { lines: ellipsize(best.lines, best.widths, measure, sep, words[0]), truncated: true };
}

/** Fit a title into a circle of the given radius. */
export function fitTitle(title: string, radius: number, lineHeight: number, measure: Measure): Fit {
  const words = title.split(/\s+/).filter(Boolean);
  const most = Math.max(1, Math.floor((2 * radius) / lineHeight));
  const candidates: number[][] = [];
  for (let n = 1; n <= most; n++) candidates.push(lineWidths(radius, Array<number>(n).fill(lineHeight)));
  return fitWords(words, candidates, measure, " ");
}

const META_SEP = " · ";

export interface LabelFit { title: Fit; meta: Fit }

/**
 * Fit an open bubble's name and, under it, its meta line (parts joined by " · ", which
 * may wrap onto a second line between parts) into the circle in its middle.
 */
export function fitLabel(
  title: string, meta: string, radius: number,
  titleHeight: number, metaHeight: number,
  measureTitle: Measure, measureMeta: Measure,
): LabelFit {
  const words = title.split(/\s+/).filter(Boolean);
  const parts = meta.split(META_SEP).filter(Boolean);
  const metaChoices = parts.length ? (parts.length > 1 ? [1, 2] : [1]) : [0];
  const most = Math.max(1, Math.floor((2 * radius - metaHeight * metaChoices[0]) / titleHeight));
  const stack = (nt: number, nm: number): number[] => lineWidths(radius, [
    ...Array<number>(nt).fill(titleHeight), ...Array<number>(nm).fill(metaHeight),
  ]);
  // First choice: everything, in as few lines as possible.
  for (let total = 1 + metaChoices[0]; total <= most + 2; total++) {
    for (const nm of metaChoices) {
      const nt = total - nm;
      if (nt < 1 || nt > most) continue;
      const widths = stack(nt, nm);
      const t = fill(words, widths.slice(0, nt), measureTitle, " ");
      const m = fill(parts, widths.slice(nt), measureMeta, META_SEP);
      if (t.used === words.length && m.used === parts.length) {
        return {
          title: { lines: balance(words, widths.slice(0, nt), measureTitle, " ") ?? t.lines, truncated: false },
          meta: { lines: m.lines, truncated: false },
        };
      }
    }
  }
  // Otherwise the name comes first: the fewest lines that hold it, over one meta
  // line cut short; and if even the name doesn't fit, as much of it as does.
  const nm = metaChoices[0];
  let fallback: LabelFit | null = null;
  for (let nt = 1; nt <= most; nt++) {
    const widths = stack(nt, nm);
    const title = fitWords(words, [widths.slice(0, nt)], measureTitle, " ");
    fallback = { title, meta: fitWords(parts, [widths.slice(nt)], measureMeta, META_SEP) };
    if (!title.truncated) break;
  }
  return fallback ?? { title: fitTitle(title, radius, titleHeight, measureTitle), meta: { lines: [], truncated: parts.length > 0 } };
}

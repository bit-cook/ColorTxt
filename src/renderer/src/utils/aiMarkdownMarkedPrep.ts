/**
 * AI Markdown 进入 marked 前的轻量归一化。
 */

/**
 * 匹配单行内一段 `**…**`：内层不含换行、不把 `**` 当正文（允许单个 `*`）。
 * 用 `replace` 在整段两侧按需补空格，等价于原先的「成对扫描」，写法更短。
 */
const STRONG_SPAN_IN_LINE =
  /\*\*((?:[^*\n]|\*(?!\*))*?)\*\*/gu;

/**
 * 对每个 `**…**`：若紧前一字符非空白且非 `*`，在整段前补空格；若紧后一字符存在、
 * 非空白且不是下一组 `**` 的开头，在整段后补空格。
 * 不跨行（内层不得含 `\n`）；不处理围栏代码块。
 */
export function ensureSpacesAroundMarkdownStrongPairs(raw: string): string {
  const parts = raw.split(/(```[\s\S]*?```)/g);
  return parts
    .map((seg, idx) =>
      idx % 2 === 1 ? seg : ensureSpacesAroundMarkdownStrongPairsPlain(seg),
    )
    .join("");
}

function ensureSpacesAroundMarkdownStrongPairsPlain(plain: string): string {
  return plain
    .split("\n")
    .map((line) => ensureSpacesAroundMarkdownStrongPairsOneLine(line))
    .join("\n");
}

function ensureSpacesAroundMarkdownStrongPairsOneLine(line: string): string {
  return line.replace(
    STRONG_SPAN_IN_LINE,
    (full, _inner: string, offset: number, str: string) => {
      let out = full;
      if (offset > 0) {
        const b = str[offset - 1]!;
        if (!/\s/.test(b) && b !== "*") out = ` ${out}`;
      }
      const after = str[offset + full.length];
      if (
        after !== undefined &&
        !/\s/.test(after) &&
        !(after === "*" && str[offset + full.length + 1] === "*")
      ) {
        out += " ";
      }
      return out;
    },
  );
}

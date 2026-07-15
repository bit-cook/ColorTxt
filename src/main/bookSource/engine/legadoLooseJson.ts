/**
 * Legado/GSON 宽松 JSON：单引号字符串、无引号键。
 * 独立成文件，避免 analyzeUrl ↔ sourceRequestHeaders 循环依赖。
 */

/** 单引号字面量转双引号，并转义内部 `"`（供 body: '{"a":1}' 一类 UrlOption） */
export function normalizeLegadoLooseJson(raw: string): string {
  return raw
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner: string) => {
      const escaped = String(inner)
        .replace(/\\'/g, "'")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      return `"${escaped}"`;
    })
    .replace(/(\{|,)\s*([a-zA-Z_-][\w-]*)\s*:/g, '$1"$2":');
}

export function parseLegadoLooseJsonObject(
  raw: string,
): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const text of [trimmed, normalizeLegadoLooseJson(trimmed)]) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

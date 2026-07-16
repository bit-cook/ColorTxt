/**
 * 「文本替换」纯函数：渲染进程阅读展示。
 * 与「转换」（简繁/全半角）同属展示层变换，阅读路径应在转换之前调用。
 */
import {
  getValidTimeoutMillisecond,
  isReplaceRuleValid,
  type ReplaceRule,
} from "./replaceRule";

export function scopeMatches(
  haystack: string | null | undefined,
  name: string,
  origin: string,
): boolean {
  if (haystack == null || !String(haystack).trim()) return true;
  const s = String(haystack);
  return s.includes(name) || s.includes(origin);
}

export function excludeMatches(
  haystack: string | null | undefined,
  name: string,
  origin: string,
): boolean {
  if (haystack == null || !String(haystack).trim()) return false;
  const s = String(haystack);
  return s.includes(name) || s.includes(origin);
}

/** 对齐 Legado `findEnabledByContentScope` / `findEnabledByTitleScope` */
export function filterEnabledReplaceRules(
  rules: ReplaceRule[],
  bookName: string,
  bookOrigin: string,
  kind: "content" | "title",
): ReplaceRule[] {
  return rules.filter((rule) => {
    if (!rule.isEnabled) return false;
    if (kind === "content" && !rule.scopeContent) return false;
    if (kind === "title" && !rule.scopeTitle) return false;
    if (!scopeMatches(rule.scope, bookName, bookOrigin)) return false;
    if (excludeMatches(rule.excludeScope, bookName, bookOrigin)) return false;
    return true;
  });
}

function applyOneRule(text: string, rule: ReplaceRule, logs?: string[]): string {
  if (!rule.pattern) return text;
  if (!isReplaceRuleValid(rule)) {
    logs?.push(`文本替换：规则「${rule.name || rule.id}」无效，已跳过`);
    return text;
  }
  try {
    if (rule.isRegex) {
      // 浏览器 / Node 均无法可靠打断同步灾难回溯；timeout 字段保留兼容
      void getValidTimeoutMillisecond(rule);
      const re = new RegExp(rule.pattern, "g");
      return text.replace(re, rule.replacement ?? "");
    }
    return text.split(rule.pattern).join(rule.replacement ?? "");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logs?.push(`文本替换：规则「${rule.name || rule.id}」出错: ${msg}`);
    return text;
  }
}

export function applyReplaceRulesToText(
  text: string,
  rules: ReplaceRule[],
  logs?: string[],
): string {
  let out = text;
  for (const rule of rules) {
    out = applyOneRule(out, rule, logs);
  }
  return out;
}

/** 正文净化：先按行 trim，再套用规则 */
export function applyContentReplaceWithRules(
  content: string,
  rules: ReplaceRule[],
  logs?: string[],
): string {
  if (!rules.length) return content;
  if (content === "null" || content == null) return content;
  const trimmed = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n");
  return applyReplaceRulesToText(trimmed, rules, logs);
}

/** 章节标题净化 */
export function applyTitleReplaceWithRules(
  title: string,
  rules: ReplaceRule[],
  logs?: string[],
): string {
  if (!rules.length) return title;
  return applyReplaceRulesToText(title.replace(/\r?\n/g, ""), rules, logs);
}

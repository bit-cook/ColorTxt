/**
 * Legado 书源 JS 在 Rhino 中同步调用 java.startBrowserAwait / java.ajax；
 * 在 Node 中须自动插入 await，并用 AsyncFunction 执行。
 *
 * Rhino 另有两类与标准 JS 不兼容的写法，须在 eval 前预处理：
 * 1. `.map([a,b]=>` — 数组解构箭头参数须写成 `.map(([a,b])=>`
 * 2. 脚本末尾表达式（如 `JSON.stringify(list)`）Rhino 会作为返回值，Node 须补 `return`
 */

/** Legado/Rhino：`.map([title,id]=>` → `.map(([title,id])=>` */
export function fixRhinoBareArrayArrowParams(script: string): string {
  return script.replace(
    /(\.[\w$]+\s*\(\s*)\[([^\]]+)\]\s*=>/g,
    "$1([$2])=>",
  );
}

function hasLegadoTopLevelStatements(script: string): boolean {
  if (
    /(?:^|\n)\s*(?:const|let|var|function|for|while|if|try|class|import|export|eval)\b/.test(
      script,
    )
  ) {
    return true;
  }
  if (/(?:^|\n)\s*[\w$]+\s*=\s*/.test(script)) return true;
  // 多语句：`eval(...); run(...)` 等，勿整体包成 return (a; b)
  const withoutTrailingSemi = script.replace(/;\s*$/, "");
  return /;\s*\S/.test(withoutTrailingSemi);
}

/** 多行 JSON.stringify({ ... }) 等：从末尾回溯到表达式起始行（仅匹配 ()[]，避免 if { } 块误判） */
function findTrailingExpressionStartLine(lines: string[], endLineIdx: number): number {
  let depth = 0;
  for (let li = endLineIdx; li >= 0; li--) {
    const line = lines[li];
    for (let ci = line.length - 1; ci >= 0; ci--) {
      const c = line[ci];
      if (c === ")" || c === "]") depth++;
      else if (c === "(" || c === "[") {
        depth--;
        if (depth === 0 && (li < endLineIdx || ci > 0)) return li;
      }
    }
  }
  return endLineIdx;
}

/** 跳过正则字面量；start 指向开头 `/`，返回结束下标（flags 之后） */
function skipRegexLiteral(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      i++;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (ch === "/") {
      i++;
      while (i < src.length && /[gimsuy]/.test(src[i]!)) i++;
      return i;
    }
    if (ch === "\n" || ch === "\r") return i;
    i++;
  }
  return i;
}

/**
 * 上一非空白 token 是否允许出现正则字面量（避免把除法 `/` 当成正则）。
 * 注释与字符串内不会走到这里。
 */
function canStartRegexLiteral(src: string, slashIdx: number): boolean {
  let i = slashIdx - 1;
  while (i >= 0 && /[ \t\n\r]/.test(src[i]!)) i--;
  if (i < 0) return true;
  const ch = src[i]!;
  if ("([{,;=:!&|?~%^<>+-*%".includes(ch)) return true;
  // return /x/、case /x/: 等
  if (/[A-Za-z_$]/.test(ch)) {
    let j = i;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j]!)) j--;
    const word = src.slice(j + 1, i + 1);
    return /^(?:return|case|throw|typeof|delete|void|new|in|of|instanceof|else|do|yield|await)$/.test(
      word,
    );
  }
  return false;
}

type MatchDelim = "{" | "(";

/**
 * 从开括号匹配到对应闭括号；跳过字符串、模板、行/块注释、正则字面量。
 * （注释里的引号、正则字符类里的 `'` 否则会破坏括号深度，导致 jsLib 提升 async 死循环）
 */
function findMatchingDelim(src: string, openIdx: number, open: MatchDelim): number {
  const close = open === "{" ? "}" : ")";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escape = false;

  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (inSingle) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "`") inTemplate = false;
      continue;
    }

    if (ch === "/" && i + 1 < src.length) {
      const next = src[i + 1]!;
      if (next === "/") {
        i = src.indexOf("\n", i + 2);
        if (i < 0) return -1;
        continue;
      }
      if (next === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) return -1;
        i = end + 1;
        continue;
      }
      if (canStartRegexLiteral(src, i)) {
        i = skipRegexLiteral(src, i) - 1;
        continue;
      }
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      continue;
    }

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingBrace(src: string, openIdx: number): number {
  return findMatchingDelim(src, openIdx, "{");
}

function findMatchingParen(src: string, openIdx: number): number {
  return findMatchingDelim(src, openIdx, "(");
}

/** Rhino：`with(obj){ ... finalExpr }` 的值即脚本返回值（正文 AES 解密等） */
export function ensureLegadoWithBlockReturn(script: string): string {
  if (!/\bwith\s*\(/.test(script)) return script;

  let result = script;
  const withRe = /\bwith\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = withRe.exec(result))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = findMatchingParen(result, parenOpen);
    if (parenClose < 0) continue;

    let braceOpen = parenClose + 1;
    while (braceOpen < result.length && /\s/.test(result[braceOpen]!)) braceOpen++;
    if (result[braceOpen] !== "{") continue;

    const braceClose = findMatchingBrace(result, braceOpen);
    if (braceClose < 0) continue;

    const inner = result.slice(braceOpen + 1, braceClose);
    const innerLines = inner.split("\n");
    let li = innerLines.length - 1;
    while (li >= 0) {
      const t = innerLines[li]?.trim() ?? "";
      if (!t || t === "}" || t === "{") {
        li--;
        continue;
      }
      if (/^(function|async function)\b/.test(t)) break;
      if (t.startsWith("return ")) break;

      const indent = innerLines[li]?.match(/^\s*/)?.[0] ?? "";
      const expr = t.replace(/;\s*$/, "");
      innerLines[li] = `${indent}return ${expr};`;
      break;
    }

    const newInner = innerLines.join("\n");
    result = result.slice(0, braceOpen + 1) + newInner + result.slice(braceClose);
    withRe.lastIndex = braceOpen + 1 + newInner.length;
  }

  return result;
}

function legadoDeclAssignReturnName(line: string): string | null {
  const m = line.trim().match(/^(?:var|let|const)\s+([\w$]+)\s*=/);
  return m?.[1] ?? null;
}

/**
 * 单行内多个顶层语句（如 `java.put(...);java.put(...);result`）时，
 * 返回最后一句起始下标；无顶层 `;` 则返回 0。
 */
function findLastTopLevelStatementStart(line: string): number {
  let lastSemi = -1;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inSingle) {
      if (ch === "\\") escape = true;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") escape = true;
      else if (ch === "`") inTemplate = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      continue;
    }
    if (ch === "/" && i + 1 < line.length) {
      const next = line[i + 1]!;
      if (next === "/") break;
      if (next === "*") {
        const end = line.indexOf("*/", i + 2);
        if (end < 0) break;
        i = end + 1;
        continue;
      }
      if (canStartRegexLiteral(line, i)) {
        i = skipRegexLiteral(line, i) - 1;
        continue;
      }
    }
    if (ch === "(") depthParen++;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
    else if (ch === "[") depthBracket++;
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === "{") depthBrace++;
    else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);
    else if (
      ch === ";" &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0
    ) {
      lastSemi = i;
    }
  }
  if (lastSemi < 0) return 0;
  let start = lastSemi + 1;
  while (start < line.length && /\s/.test(line[start]!)) start++;
  return start;
}

/** 让 Node 与 Rhino eval 一样返回脚本最终结果 */
export function ensureLegadoScriptReturn(script: string): string {
  const trimmed = script.trim();
  if (!trimmed) return trimmed;

  if (!hasLegadoTopLevelStatements(trimmed)) {
    const expr = trimmed.replace(/;\s*$/, "");
    if (/^return\s+\([\s\S]*\)\s*;?\s*$/.test(trimmed)) return trimmed;
    const wrapped = `return (${expr});`;
    /**
     * 多语句靠换行 ASI 分隔时（如 `java.put('k',key)\n'https://…'`），
     * 整体包进 `return (…)` 后括号内不再 ASI，会变成 Unexpected string。
     * 能通过语法检查则整包返回；否则走下方「末行表达式 return」。
     */
    try {
      // eslint-disable-next-line no-new-func -- 仅作语法探测
      new Function(wrapped);
      return wrapped;
    } catch {
      // fall through
    }
  }

  const lines = trimmed.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0) return trimmed;

  const last = lines[i].trim();
  // 仅看最后一行：函数体内的 return 不影响顶层表达式作返回值（Legado/Rhino 行为）
  if (!last || last.startsWith("return ")) return trimmed;

  /**
   * 单行多语句须先于「整行 var x=… → return x」处理。
   * 否则 `var l=…;if(…){a+l}else{b}` 会被收成 `return l`，丢掉 if 里的真正返回值。
   */
  const lastStmtStartInLine = findLastTopLevelStatementStart(last);
  if (lastStmtStartInLine > 0) {
    const indent = lines[i].match(/^\s*/)?.[0] ?? "";
    const before = last.slice(0, lastStmtStartInLine);
    const stmt = last.slice(lastStmtStartInLine).replace(/;\s*$/, "").trim();
    if (stmt.startsWith("return ")) return trimmed;
    // 末行仅为 `});` / `);`（闭括号 + 分号）时 stmt 为空，不是多语句；
    // 若此处直接 return，会漏掉 `List.map(…);` / `JSON.stringify($$);` 的顶层 return
    if (stmt) {
      // if/else / for / while：交给 ensureLegadoIfElseBranchReturn，勿写成 `return if`
      if (/^(if|for|while|switch|try|with)\b/.test(stmt)) {
        lines[i] = `${indent}${before}${stmt}`;
        return lines.join("\n");
      }
      const declName = legadoDeclAssignReturnName(stmt);
      if (declName) {
        lines[i] = `${indent}${before}${stmt}; return ${declName};`;
      } else {
        lines[i] = `${indent}${before}return ${stmt};`;
      }
      return lines.join("\n");
    }
  }

  const declNameFromLast = legadoDeclAssignReturnName(last);
  if (declNameFromLast) {
    const indent = lines[i].match(/^\s*/)?.[0] ?? "";
    return `${trimmed}\n${indent}return ${declNameFromLast};`;
  }
  /**
   * switch/if 等块末尾给 result 赋值：Rhino 从作用域读 result，Node 须补 return。
   * 末行常为 `}` 或 `};`（部分书源 if/else 后多余分号）；若只认 `endsWith("}")`，
   * `};` 会落到下方被改成 `return }` → SyntaxError，搜索 bookUrl 整批失败。
   */
  const lastNoTrailSemi = last.replace(/;\s*$/, "");
  if (lastNoTrailSemi.endsWith("}")) {
    if (/\bresult\s*=/.test(trimmed) && !/\breturn\s+result\b/.test(trimmed)) {
      return `${trimmed}\nreturn result;`;
    }
    return trimmed;
  }

  /**
   * 尾部 IIFE：`(()=>{...})();` 末行是 `})();`。
   * 若写成 `return })();`，ASI 会变成 `return;`，IIFE 结果被丢掉。
   */
  if (/^[)}\]]*\s*\)\s*\(\s*\)\s*;?\s*$/.test(last)) {
    const expr = trimmed.replace(/;\s*$/, "");
    if (/^\(/.test(expr) && !/^\s*return\b/.test(expr)) {
      return `return ${expr};`;
    }
    return trimmed;
  }

  // 单行模板字符串：`${...}` 含 `}`，不可当多行表达式回溯（否则会误 return 上一句变量）
  const lastExpr = last.replace(/;\s*$/, "");
  if (lastExpr.startsWith("`") && lastExpr.endsWith("`")) {
    const indent = lines[i].match(/^\s*/)?.[0] ?? "";
    lines[i] = `${indent}return ${lastExpr};`;
    return lines.join("\n");
  }

  // 顶层 if/for 等语句后的单行返回值（如 loginCheckJs 末尾 result）勿回溯到 if 行
  // 不用 `}` 触发回溯：否则 `/files/...${sid}/...` 一类模板会被当成多行并跳到上一句
  const looksMultilineExpr =
    /[)\]]/.test(last) &&
    !/^(if|else|for|while|function|try|catch|class)\b/.test(last);
  const startLine = looksMultilineExpr
    ? findTrailingExpressionStartLine(lines, i)
    : i;
  const start = lines[startLine].trim();
  if (start.startsWith("return ")) return trimmed;

  const declNameFromStart = legadoDeclAssignReturnName(start);
  if (declNameFromStart) {
    const indent = lines[startLine].match(/^\s*/)?.[0] ?? "";
    return `${trimmed}\n${indent}return ${declNameFromStart};`;
  }

  const withoutSemi = start.replace(/;\s*$/, "");
  const indent = lines[startLine].match(/^\s*/)?.[0] ?? "";
  lines[startLine] = `${indent}return ${withoutSemi}`;
  if (startLine === i && !lines[i].trimEnd().endsWith(";")) {
    lines[i] = `${lines[i].trimEnd()};`;
  }
  return lines.join("\n");
}

/** `if (...) { foo() } else { bar() }` 以及分支末尾裸表达式补 return（对齐 Legado/Rhino） */
export function ensureLegadoIfElseBranchReturn(script: string): string {
  // 仅当整段脚本就是「if { a() } else { b() }」时用简写（发现页 category/tag 分支）
  let s = script.replace(
    /^(\s*if\s*\([\s\S]*?\)\s*\{\s*)([\w$]+\(\))(\s*\}\s*else\s*\{\s*)([\w$]+\(\))(\s*\})\s*$/,
    "$1return $2$3return $4$5",
  );
  // `if (cond) { ...; expr } else { ...; expr }`（目录规则等）：仅处理脚本末尾的 if/else
  return injectReturnIntoIfElseBranchEnds(s);
}

/** if/else 链结束后是否还有顶层语句（loginCheckJs 在 if 后还有 `result`） */
function ifElseChainIsTerminal(
  script: string,
  ifStart: number,
  chainEnd: number,
): boolean {
  if (braceDepthBefore(script, ifStart) !== 0) return false;
  let i = chainEnd + 1;
  while (i < script.length && /\s/.test(script[i]!)) i++;
  return i >= script.length;
}

/**
 * 顶层 `try { …; expr } catch (e) { …; expr }`：分支末尾表达式补 return。
 * 目录 tocUrl 常见写法；若只认 if/else，整段以 `}` 结尾时 ensureLegadoScriptReturn
 * 不会补 return → 返回 undefined → tocUrl 回退详情页。
 */
export function ensureLegadoTryCatchBranchReturn(script: string): string {
  let result = script;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const tryRe = /\btry\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = tryRe.exec(result))) {
      const tryStart = m.index;
      if (braceDepthBefore(result, tryStart) !== 0) {
        tryRe.lastIndex = tryStart + 1;
        continue;
      }
      const tryBraceOpen = m.index + m[0].length - 1;
      const tryBraceClose = findMatchingBrace(result, tryBraceOpen);
      if (tryBraceClose < 0) {
        tryRe.lastIndex = tryStart + 1;
        continue;
      }

      let after = tryBraceClose + 1;
      while (after < result.length && /\s/.test(result[after]!)) after++;
      let chainEnd = tryBraceClose;
      const catchBlocks: Array<{ open: number; close: number }> = [];

      while (/^catch\b/.test(result.slice(after))) {
        after += 5;
        while (after < result.length && /\s/.test(result[after]!)) after++;
        if (result[after] === "(") {
          const parenClose = findMatchingParen(result, after);
          if (parenClose < 0) break;
          after = parenClose + 1;
          while (after < result.length && /\s/.test(result[after]!)) after++;
        }
        if (result[after] !== "{") break;
        const catchClose = findMatchingBrace(result, after);
        if (catchClose < 0) break;
        catchBlocks.push({ open: after, close: catchClose });
        chainEnd = catchClose;
        after = catchClose + 1;
        while (after < result.length && /\s/.test(result[after]!)) after++;
      }

      if (/^finally\b/.test(result.slice(after))) {
        after += 7;
        while (after < result.length && /\s/.test(result[after]!)) after++;
        if (result[after] === "{") {
          const finClose = findMatchingBrace(result, after);
          if (finClose >= 0) chainEnd = finClose;
        }
      }

      if (!ifElseChainIsTerminal(result, tryStart, chainEnd)) {
        tryRe.lastIndex = tryStart + 1;
        continue;
      }

      const tryInj = injectTrailingReturnInBraceBlock(
        result,
        tryBraceOpen,
        tryBraceClose,
      );
      if (tryInj.changed) {
        result = tryInj.text;
        changed = true;
        tryRe.lastIndex = Math.max(tryInj.nextIndex, tryStart + 1);
        continue;
      }

      let catchChanged = false;
      for (const cb of catchBlocks) {
        const catchInj = injectTrailingReturnInBraceBlock(
          result,
          cb.open,
          cb.close,
        );
        if (catchInj.changed) {
          result = catchInj.text;
          changed = true;
          catchChanged = true;
          tryRe.lastIndex = Math.max(catchInj.nextIndex, tryStart + 1);
          break;
        }
      }
      if (catchChanged) continue;

      tryRe.lastIndex = Math.max(chainEnd + 1, tryStart + 1);
    }
    if (!changed) break;
  }
  return result;
}

/** 解析 if 后紧随的 else / else if 链，返回整条链结束下标 */
function findIfElseChainEnd(script: string, thenBraceClose: number): number {
  let end = thenBraceClose;
  let after = thenBraceClose + 1;
  while (after < script.length && /\s/.test(script[after]!)) after++;
  while (/^else\b/.test(script.slice(after))) {
    after += 4;
    while (after < script.length && /\s/.test(script[after]!)) after++;
    if (/^if\s*\(/.test(script.slice(after))) {
      const ifMatch = /^if\s*\(/.exec(script.slice(after));
      if (!ifMatch) break;
      const parenOpen = after + ifMatch[0].length - 1;
      const parenClose = findMatchingParen(script, parenOpen);
      if (parenClose < 0) break;
      let braceOpen = parenClose + 1;
      while (braceOpen < script.length && /\s/.test(script[braceOpen]!)) braceOpen++;
      if (script[braceOpen] !== "{") break;
      const braceClose = findMatchingBrace(script, braceOpen);
      if (braceClose < 0) break;
      end = braceClose;
      after = braceClose + 1;
      while (after < script.length && /\s/.test(script[after]!)) after++;
      continue;
    }
    if (script[after] === "{") {
      const elseClose = findMatchingBrace(script, after);
      if (elseClose < 0) break;
      return elseClose;
    }
    break;
  }
  return end;
}

/** 在顶层 if/else 花括号块末尾表达式前插入 return（不改写已有 return） */
function injectReturnIntoIfElseBranchEnds(script: string): string {
  let result = script;
  // 反复扫描，直到无法再改写
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const ifRe = /\bif\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = ifRe.exec(result))) {
      const startIdx = m.index;
      const parenOpen = m.index + m[0].length - 1;
      const parenClose = findMatchingParen(result, parenOpen);
      if (parenClose < 0) {
        ifRe.lastIndex = startIdx + 1;
        continue;
      }

      let braceOpen = parenClose + 1;
      while (braceOpen < result.length && /\s/.test(result[braceOpen]!)) braceOpen++;
      if (result[braceOpen] !== "{") {
        ifRe.lastIndex = startIdx + 1;
        continue;
      }

      const braceClose = findMatchingBrace(result, braceOpen);
      if (braceClose < 0) {
        ifRe.lastIndex = startIdx + 1;
        continue;
      }

      const chainEnd = findIfElseChainEnd(result, braceClose);
      // loginCheckJs：`if (…) { …; java.log(…) } \n result` — if 非末尾语句时勿往分支里塞 return
      if (!ifElseChainIsTerminal(result, startIdx, chainEnd)) {
        ifRe.lastIndex = Math.max(braceClose + 1, startIdx + 1);
        continue;
      }

      const injected = injectTrailingReturnInBraceBlock(result, braceOpen, braceClose);
      if (injected.changed) {
        result = injected.text;
        changed = true;
        ifRe.lastIndex = Math.max(injected.nextIndex, startIdx + 1);
        continue;
      }

      // else / else if 紧随其后
      let after = braceClose + 1;
      while (after < result.length && /\s/.test(result[after]!)) after++;
      if (!/^else\b/.test(result.slice(after))) {
        ifRe.lastIndex = Math.max(braceClose + 1, startIdx + 1);
        continue;
      }
      after += 4;
      while (after < result.length && /\s/.test(result[after]!)) after++;
      if (result[after] === "{") {
        const elseClose = findMatchingBrace(result, after);
        if (elseClose >= 0) {
          const elseInj = injectTrailingReturnInBraceBlock(result, after, elseClose);
          if (elseInj.changed) {
            result = elseInj.text;
            changed = true;
            ifRe.lastIndex = Math.max(elseInj.nextIndex, startIdx + 1);
            continue;
          }
        }
      }
      ifRe.lastIndex = Math.max(braceClose + 1, startIdx + 1);
    }
    if (!changed) break;
  }
  return result;
}

/** 计算 `src[0..endExclusive)` 内未闭合的 `{` 深度（跳过字符串/注释/正则） */
function braceDepthBefore(src: string, endExclusive: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escape = false;

  for (let i = 0; i < endExclusive && i < src.length; i++) {
    const ch = src[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (inSingle) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "`") inTemplate = false;
      continue;
    }

    if (ch === "/" && i + 1 < src.length) {
      const next = src[i + 1]!;
      if (next === "/") {
        const nl = src.indexOf("\n", i + 2);
        i = nl < 0 ? src.length : nl;
        continue;
      }
      if (next === "*") {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) break;
        i = end + 1;
        continue;
      }
      if (canStartRegexLiteral(src, i)) {
        i = skipRegexLiteral(src, i) - 1;
        continue;
      }
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function injectTrailingReturnInBraceBlock(
  src: string,
  braceOpen: number,
  braceClose: number,
): { text: string; changed: boolean; nextIndex: number } {
  const inner = src.slice(braceOpen + 1, braceClose);
  const innerLines = inner.split("\n");
  let lineStart = 0;
  const lineStarts: number[] = [];
  for (let i = 0; i < innerLines.length; i++) {
    lineStarts.push(lineStart);
    lineStart += (innerLines[i]?.length ?? 0) + 1;
  }
  let li = innerLines.length - 1;
  while (li >= 0) {
    const t = innerLines[li]?.trim() ?? "";
    if (!t || t === "}" || t === "{") {
      li--;
      continue;
    }
    // for/while/if 体内的末行不可当分支返回值（urlEncode 等）
    if (braceDepthBefore(inner, lineStarts[li] ?? 0) !== 0) {
      li--;
      continue;
    }
    if (/^(function|async function|if|else|for|while|try|catch|switch)\b/.test(t)) {
      break;
    }
    if (t.startsWith("return ")) break;
    // continue/break 是控制流语句，不是返回值（误写成 return continue 会 SyntaxError）
    if (/^(continue|break)\b/.test(t)) break;

    const indent = innerLines[li]?.match(/^\s*/)?.[0] ?? "";
    const expr = t.replace(/;\s*$/, "");
    // 分支内单表达式（含 `java.get('x')+l`）补 return；排除控制流与多语句
    if (/[;\n]/.test(expr) || /\b(if|for|while|switch|try|function|class)\b/.test(expr)) {
      break;
    }
    // 保留字/字面量可作表达式；排除不可出现在 return 后的标识符式关键字
    if (
      /^(continue|break|case|default|else|catch|finally|do|while|for|function|class|import|export|throw|yield|await)$/.test(
        expr,
      )
    ) {
      break;
    }
    innerLines[li] = `${indent}return ${expr};`;
    const newInner = innerLines.join("\n");
    const text =
      src.slice(0, braceOpen + 1) + newInner + src.slice(braceClose);
    return {
      text,
      changed: true,
      nextIndex: braceOpen + 1 + newInner.length + 1,
    };
  }
  return { text: src, changed: false, nextIndex: braceClose + 1 };
}

/** `if(result){ eval(result) }` → 补 return eval(result)（Legado/Rhino 会返回 eval 结果） */
export function ensureLegadoIfEvalReturn(script: string): string {
  return script.replace(
    /(\bif\s*\(\s*result\s*\)\s*\{\s*)eval\s*\(\s*result\s*\)/g,
    "$1return eval(result)",
  );
}

/**
 * 快照 `result` 并仅给**数组**补 List.toArray（字符串/对象原样保留，避免打断 .replace/.map）。
 * 用 `let result` 阴影全局，避免 await java.ajax 期间嵌套 @js 覆盖共享沙箱。
 * List API 须不可枚举：`for (i in $)` / `for (i in result)` 不可扫到 toArray 等键。
 */
export const LEGADO_RESULT_LIST_PRELUDE = `let result = (() => {
  const r = globalThis.result;
  if (Array.isArray(r) && typeof r.toArray !== "function") {
    const def = (k, v) => Object.defineProperty(r, k, {
      configurable: true, writable: true, enumerable: false, value: v
    });
    def("toArray", function () { return this.slice(); });
    def("isEmpty", function () { return this.length === 0; });
    def("size", function () { return this.length; });
    def("get", function (i) { return this[i]; });
  }
  return r;
})();`;

export const LEGADO_RESULT_LIST_PRELUDE_INPLACE = `(() => {
  const r = typeof result !== "undefined" ? result : globalThis.result;
  if (!Array.isArray(r) || typeof r.toArray === "function") return;
  const def = (k, v) => Object.defineProperty(r, k, {
    configurable: true, writable: true, enumerable: false, value: v
  });
  def("toArray", function () { return this.slice(); });
  def("isEmpty", function () { return this.length === 0; });
  def("size", function () { return this.length; });
  def("get", function (i) { return this[i]; });
})();`;

/** 同步/异步 Legado JS 通用预处理 */
export function prepareLegadoJs(script: string): string {
  let s = script.trim();
  if (/^<js>/i.test(s)) {
    s = s.replace(/^<js>/i, "").replace(/<\/js>\s*$/i, "").trim();
  } else if (/^@js:/i.test(s)) {
    s = s.replace(/^@js:\s*/i, "").trim();
  } else if (/^js:/i.test(s)) {
    s = s.replace(/^js:\s*/i, "").trim();
  }
  s = fixRhinoBareArrayArrowParams(s);
  s = ensureLegadoWithBlockReturn(s);
  s = ensureLegadoIfElseBranchReturn(s);
  s = ensureLegadoTryCatchBranchReturn(s);
  s = ensureLegadoIfEvalReturn(s);
  s = ensureLegadoScriptReturn(s);
  // 必须在 return 补全之后：prelude 本身不是返回值
  // 仅当脚本会用到 result 时注入；字符串 result 必须保持可 .replace
  if (!/\bresult\b/.test(s) && !/\bresult\b/.test(script)) {
    return s;
  }
  if (/\b(?:let|const|var)\s+result\b/.test(s)) {
    s = `${LEGADO_RESULT_LIST_PRELUDE_INPLACE}\n${s}`;
  } else {
    s = `${LEGADO_RESULT_LIST_PRELUDE}\n${s}`;
  }
  return s;
}

/** 仅将函数体内含 await 的 function / 箭头函数提升为 async（避免 urlEncode 等同步 helper 变 Promise） */
export function promoteFunctionsToAsyncForAwait(script: string): string {
  if (!/\bawait\b/.test(script)) return script;
  return promoteBlockArrowsToAsync(
    promoteArrowAssignmentsToAsync(
      promoteClassicFunctionsToAsync(script),
    ),
  );
}

function promoteClassicFunctionsToAsync(script: string): string {
  let out = "";
  let pos = 0;
  const headRe =
    /\b(?:(?:var|let|const)\s+\w+\s*=\s*)?(async\s+)?function(\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/g;

  let m: RegExpExecArray | null;
  while ((m = headRe.exec(script))) {
    out += script.slice(pos, m.index);
    const braceIdx = m.index + m[0].length - 1;
    const endBrace = findMatchingBrace(script, braceIdx);
    if (endBrace < 0) {
      // 无法匹配体：跳过本头，避免 pos 回退导致无限拼接
      out += m[0];
      pos = m.index + m[0].length;
      headRe.lastIndex = pos;
      continue;
    }
    const head = script.slice(m.index, braceIdx + 1);
    const body = promoteClassicFunctionsToAsync(
      script.slice(braceIdx + 1, endBrace),
    );
    let fullFn = `${head}${body}}`;
    if (!m[1] && /\bawait\b/.test(fullFn)) {
      fullFn = fullFn.replace(
        /(\b(?:var|let|const)\s+\w+\s*=\s*)?function\b/,
        "$1async function",
      );
    }
    out += fullFn;
    pos = endBrace + 1;
    headRe.lastIndex = pos;
  }
  out += script.slice(pos);
  return out;
}

/** `getData = (uri) => { await ... }` / `run = Path => { await getData() }` */
function promoteArrowAssignmentsToAsync(script: string): string {
  let out = "";
  let pos = 0;
  const headRe =
    /\b(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?((?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{)/g;

  let m: RegExpExecArray | null;
  while ((m = headRe.exec(script))) {
    out += script.slice(pos, m.index);
    const braceIdx = m.index + m[0].length - 1;
    const endBrace = findMatchingBrace(script, braceIdx);
    if (endBrace < 0) {
      out += m[0];
      pos = m.index + m[0].length;
      headRe.lastIndex = pos;
      continue;
    }
    const head = script.slice(m.index, braceIdx + 1);
    const body = promoteArrowAssignmentsToAsync(
      script.slice(braceIdx + 1, endBrace),
    );
    let fullFn = `${head}${body}}`;
    if (!m[2] && /\bawait\b/.test(fullFn)) {
      fullFn = fullFn.replace(
        /^((?:(?:var|let|const)\s+)?[A-Za-z_$][\w$]*\s*=\s*)/,
        "$1async ",
      );
    }
    out += fullFn;
    pos = endBrace + 1;
    headRe.lastIndex = pos;
  }
  out += script.slice(pos);
  return out;
}

/**
 * `arr.forEach(node => { await ... })` / `(x) => { await ... }`：
 * 回调体含 await 时须标成 async（赋值箭头由 promoteArrowAssignmentsToAsync 处理）。
 */
function promoteBlockArrowsToAsync(script: string): string {
  let out = "";
  let pos = 0;
  // 单参数或一层括号参数；嵌套默认值较少见于书源 forEach
  const headRe =
    /(\basync\s+)?(\((?:[^()]|\([^()]*\))*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;

  let m: RegExpExecArray | null;
  while ((m = headRe.exec(script))) {
    out += script.slice(pos, m.index);
    const braceIdx = m.index + m[0].length - 1;
    const endBrace = findMatchingBrace(script, braceIdx);
    if (endBrace < 0) {
      out += m[0];
      pos = m.index + m[0].length;
      headRe.lastIndex = pos;
      continue;
    }
    const head = script.slice(m.index, braceIdx + 1);
    const body = promoteBlockArrowsToAsync(
      script.slice(braceIdx + 1, endBrace),
    );
    let fullFn = `${head}${body}}`;
    if (!m[1] && /\bawait\b/.test(fullFn)) {
      fullFn = `async ${fullFn}`;
    }
    out += fullFn;
    pos = endBrace + 1;
    headRe.lastIndex = pos;
  }
  out += script.slice(pos);
  return out;
}

/** 收集脚本中已声明的 async function / async 箭头赋值名 */
export function collectAsyncFunctionNames(script: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*async\s+function\b/g,
    /\b(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*async\s+(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(script))) {
      if (m[1]) names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * 将 `eval(String(source.bookSourceComment))` 展开为注释正文，使 prepare 可改写其中的
 * java.ajaxAll 等异步调用，并保持与 Legado `eval` 相同作用域（run / host 等泄漏到外层）。
 */
export function inlineBookSourceCommentEvals(
  script: string,
  sourceComment: string | null | undefined,
): string {
  if (sourceComment == null || sourceComment === "") return script;
  if (!/\beval\s*\(\s*(?:String\s*\(\s*)?source\.bookSourceComment/.test(script)) {
    return script;
  }
  // 注释自身再 eval 自身时避免死循环
  if (/\beval\s*\(\s*(?:String\s*\(\s*)?source\.bookSourceComment/.test(sourceComment)) {
    return script;
  }
  return script
    .replace(
      /\beval\s*\(\s*String\s*\(\s*source\.bookSourceComment\s*\)\s*\)\s*;?/g,
      // 必须用函数替换：字符串替换会把注释里的 $$ 吃成 $（MDN: $$ → $）
      () => `${sourceComment}\n`,
    )
    .replace(
      /\beval\s*\(\s*source\.bookSourceComment\s*\)\s*;?/g,
      () => `${sourceComment}\n`,
    );
}

/**
 * 对 async 函数的调用补 await。
 * Legado/Rhino 中嵌套函数调用是同步阻塞的；Node 中须逐层 await 才能等 toast 等副作用完成。
 */
export function awaitAsyncFunctionCalls(
  script: string,
  extraNames: readonly string[] = [],
): string {
  const names = [
    ...new Set([...collectAsyncFunctionNames(script), ...extraNames]),
  ];
  if (!names.length) return script;

  let s = script;
  for (const name of names) {
    const escaped = name.replace(/\$/g, "\\$");
    // 裸调用：getWbiEnc(
    s = s.replace(
      new RegExp(
        `(?<![\\w.$])(?<!(?:await|function)\\s)${escaped}\\s*\\(`,
        "g",
      ),
      `await ${name}(`,
    );
    // 成员调用：this.getWbiEnc( / obj.getWbiEnc(
    s = s.replace(
      new RegExp(
        `(?<!\\bawait\\s)(\\b(?:this|[A-Za-z_$][\\w$]*)\\s*\\.\\s*)${escaped}\\s*\\(`,
        "g",
      ),
      `await $1${name}(`,
    );
  }
  return s.replace(/\bawait\s+await\s+/g, "await ");
}

/** 交替提升 async 与补 await，直到嵌套调用链稳定 */
export function promoteLegadoAsyncCallChain(
  script: string,
  extraAsyncNames: readonly string[] = [],
): string {
  let s = script;
  for (let i = 0; i < 8; i++) {
    const next = awaitAsyncFunctionCalls(
      promoteFunctionsToAsyncForAwait(s),
      extraAsyncNames,
    );
    if (next === s) break;
    s = next;
  }
  return s;
}

const JAVA_HTTP_CHAIN_MEMBER =
  /^(matchAll|match|trim|replace|split|slice|substring|indexOf|includes|startsWith|body|header|headers|code|url|raw)\s*\(/;

/**
 * 判断 `java.get(...)` 实参是否为 HTTP 调用（对齐 jsExtensions.isHttpGetKey 的可静态判定部分）：
 * - 两参数（含 header）→ HTTP
 * - 单参数且字面量以 http(s):// 或 // 开头 → HTTP
 * 单参数变量键如 `java.get("headers")` / `java.get(key)` 不 await，避免与源变量 API 冲突。
 */
function isJavaGetHttpCallArgs(argsInner: string): boolean {
  const trimmed = argsInner.trim();
  if (!trimmed) return false;

  let depth = 0;
  let inStr: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth += 1;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && c === ",") return true;
  }

  return (
    /^(['"`])https?:\/\//i.test(trimmed) || /^(['"`])\/\//.test(trimmed)
  );
}

/**
 * 仅为 HTTP 形态的 `java.get` 注入 await；源变量 `java.get("key")` 保持同步。
 */
function awaitJavaGetHttpCalls(script: string): string {
  let s = script;
  const prefixRe = /(?<!await\s{1,4})\bjava\.get\s*\(/g;
  while (true) {
    prefixRe.lastIndex = 0;
    let rewritten = false;
    let m: RegExpExecArray | null;
    while ((m = prefixRe.exec(s))) {
      const start = m.index;
      const openParen = start + m[0].length - 1;
      const closeParen = findMatchingParen(s, openParen);
      if (closeParen < 0) continue;
      const argsInner = s.slice(openParen + 1, closeParen);
      if (!isJavaGetHttpCallArgs(argsInner)) continue;
      s = `${s.slice(0, start)}await java.get(${argsInner})${s.slice(closeParen + 1)}`;
      rewritten = true;
      break;
    }
    if (!rewritten) break;
  }
  return s;
}

function wrapAwaitJavaHttpMemberAccess(script: string): string {
  const methods = ["ajax", "connect", "post", "get"] as const;
  let s = script;

  for (const method of methods) {
    const prefix = `await java.${method}(`;
    while (true) {
      let wrapAt = -1;
      let wrapClose = -1;

      for (let pos = 0; pos < s.length; ) {
        const start = s.indexOf(prefix, pos);
        if (start < 0) break;
        pos = start + 1;

        const openParen = start + prefix.length - 1;
        const closeParen = findMatchingParen(s, openParen);
        if (closeParen < 0) continue;

        const after = s.slice(closeParen + 1);
        if (!after.startsWith(".") || !JAVA_HTTP_CHAIN_MEMBER.test(after.slice(1))) {
          continue;
        }

        const alreadyWrapped =
          start > 0 && s[start - 1] === "(" && s[closeParen + 1] === ")";
        if (alreadyWrapped) continue;

        wrapAt = start;
        wrapClose = closeParen;
      }

      if (wrapAt < 0) break;
      s = `${s.slice(0, wrapAt)}(${s.slice(wrapAt, wrapClose + 1)})${s.slice(wrapClose + 1)}`;
    }
  }

  return s;
}

/**
 * 注入 java.ajax / post / get(HTTP) 等 await，并提升含 await 的函数为 async。
 * 不包 IIFE、不补顶层 return（供 jsLib 共享作用域与规则脚本共用）。
 */
export function injectLegadoAsyncAwaits(
  script: string,
  extraAsyncNames: readonly string[] = [],
): string {
  let s = script;

  // startBrowserAwait(...).body() / .code() / .url()
  s = s.replace(
    /java\.startBrowserAwait\(((?:[^()]|\([^()]*\))*)\)\.(body|code|url)\(\)/g,
    "(await java.startBrowserAwait($1)).$2()",
  );

  const asyncJavaCalls = [
    "startBrowserAwait",
    "ajax",
    "ajaxAll",
    "connect",
    "post",
    "getVerificationCode",
    "refreshTocUrl",
    "reGetBook",
    // loginCheckJs：`java.webView(...); result = java.getStrResponse()` 须先等 Cookie 再重请求
    "webView",
    "webViewGetOverrideUrl",
    "webViewGetSource",
    "getStrResponse",
    "getResponse",
  ] as const;
  for (const name of asyncJavaCalls) {
    s = s.replace(
      new RegExp(`(?<!await\\s{1,4})\\bjava\\.${name}\\s*\\(`, "g"),
      `await java.${name}(`,
    );
  }

  s = awaitJavaGetHttpCalls(s);

  s = s.replace(
    /await\s+java\.ajaxAll\(((?:[^()]|\([^()]*\))*)\)\s*\[/g,
    "(await java.ajaxAll($1))[",
  );

  s = wrapAwaitJavaHttpMemberAccess(s);
  s = s.replace(/\bawait\s+await\s+/g, "await ");
  s = promoteLegadoAsyncCallChain(s, extraAsyncNames);
  s = wrapAwaitCallMemberAccess(s);
  return s.replace(/\bawait\s+await\s+/g, "await ");
}

/**
 * jsLib 专用：异步注入并收集需在规则脚本中 await 的函数名。
 * （双点号等 Rhino 预处理由 sharedJsScope.prepareJsLib 负责）
 */
export function prepareJsLibAsyncBody(script: string): {
  code: string;
  asyncFunctionNames: string[];
} {
  const code = injectLegadoAsyncAwaits(script);
  return {
    code,
    asyncFunctionNames: collectAsyncFunctionNames(code),
  };
}

export function prepareLegadoAsyncJs(
  script: string,
  extraAsyncNames: readonly string[] = [],
): string {
  let s = prepareLegadoJs(script);
  s = injectLegadoAsyncAwaits(s, extraAsyncNames);
  return `(async () => { ${s} })()`;
}

/**
 * `await fn(...).member` 实际是 `await (fn(...).member)`（. 优先于 await）。
 * 异步 fn 返回 Promise 时须写成 `(await fn(...)).member`。
 * 同样处理 `await this.fn(...).member`。
 */
function wrapAwaitCallMemberAccess(script: string): string {
  let s = script;
  while (true) {
    let wrapAt = -1;
    let wrapClose = -1;

    for (let pos = 0; pos < s.length; ) {
      const m =
        /\bawait\s+(?:this|[A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/.exec(
          s.slice(pos),
        );
      if (!m) break;
      const start = pos + m.index!;
      pos = start + 1;

      const openParen = start + m[0].length - 1;
      const closeParen = findMatchingParen(s, openParen);
      if (closeParen < 0) continue;

      const after = s.slice(closeParen + 1);
      if (!after.startsWith(".") || !/^[A-Za-z_$]/.test(after.slice(1))) {
        continue;
      }

      const alreadyWrapped =
        start > 0 && s[start - 1] === "(" && s[closeParen + 1] === ")";
      if (alreadyWrapped) continue;

      wrapAt = start;
      wrapClose = closeParen;
    }

    if (wrapAt < 0) break;
    s = `${s.slice(0, wrapAt)}(${s.slice(wrapAt, wrapClose + 1)})${s.slice(wrapClose + 1)}`;
  }

  return s;
}

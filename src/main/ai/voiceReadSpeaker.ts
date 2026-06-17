import type { AIChatEndpoint } from "@shared/aiTypes";
import type { AITokenUsageTotals } from "@shared/aiTokenUsage";
import type {
  VoiceReadAttributeSpeakersRequest,
  VoiceReadQuoteAttribution,
  VoiceReadQuoteVoiceKind,
} from "@shared/voiceReadSpeakerIpc";
import { chatCompletionOnce } from "./chat/chat";

function stripJsonFence(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return m ? m[1]!.trim() : t;
}

function normalizeQuoteKind(raw: unknown): VoiceReadQuoteVoiceKind {
  if (typeof raw !== "string") return "unknown";
  const k = raw.trim().toLowerCase();
  if (
    k === "narration" ||
    k === "非对白" ||
    k === "旁白" ||
    k === "non_dialogue"
  ) {
    return "narration";
  }
  if (k === "male" || k === "男声" || k === "男") return "male";
  if (k === "female" || k === "女声" || k === "女") return "female";
  return "unknown";
}

function unknownQuotes(count: number): VoiceReadQuoteAttribution[] {
  return Array.from({ length: count }, () => ({
    kind: "unknown" as const,
    speaker: null,
  }));
}

function buildRosterNameMap(
  roster: VoiceReadAttributeSpeakersRequest["roster"],
): Map<string, string> {
  const nameSet = new Map<string, string>();
  for (const r of roster) {
    const dn = r.displayName.trim();
    if (dn) nameSet.set(dn.toLowerCase(), dn);
    for (const a of r.aliases) {
      const al = a.trim();
      if (al) nameSet.set(al.toLowerCase(), dn);
    }
  }
  return nameSet;
}

function normalizeSpeaker(
  raw: unknown,
  nameSet: Map<string, string>,
): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return nameSet.get(key) ?? raw.trim();
}

function parseQuoteAttribution(
  raw: unknown,
  nameSet: Map<string, string>,
): VoiceReadQuoteAttribution {
  if (!raw || typeof raw !== "object") {
    return { kind: "unknown", speaker: null };
  }
  const o = raw as Record<string, unknown>;
  const kind = normalizeQuoteKind(o.kind ?? o.type ?? o.label);
  const speaker = normalizeSpeaker(o.speaker ?? o.name, nameSet);
  if (kind === "narration") {
    return { kind: "narration", speaker: null };
  }
  return { kind, speaker };
}

function parseLegacySpeakers(
  speakers: unknown[],
  quoteCount: number,
  nameSet: Map<string, string>,
): VoiceReadQuoteAttribution[] {
  const out: VoiceReadQuoteAttribution[] = [];
  for (let i = 0; i < quoteCount; i++) {
    const speaker = normalizeSpeaker(speakers[i], nameSet);
    out.push({ kind: "unknown", speaker });
  }
  return out;
}

export async function attributeVoiceReadSpeakers(
  chat: AIChatEndpoint,
  req: VoiceReadAttributeSpeakersRequest,
  signal?: AbortSignal,
): Promise<{
  quotes: VoiceReadQuoteAttribution[];
  tokenUsage: AITokenUsageTotals | null;
}> {
  const quoteTexts = req.dialogueTexts.map((t) => t.trim()).filter(Boolean);
  if (quoteTexts.length === 0) {
    return { quotes: [], tokenUsage: null };
  }

  const rosterLines =
    req.roster.length > 0
      ? req.roster
          .map((r) => {
            const aliasPart =
              r.aliases.length > 0
                ? `（别名：${r.aliases.map((a) => `「${a}」`).join("、")}）`
                : "";
            return `- ${r.displayName}${aliasPart}`;
          })
          .join("\n")
      : "（无角色卡）";

  const quoteList = quoteTexts
    .map((t, i) => `${i + 1}. 「${t}」`)
    .join("\n");

  const system = `你是中文小说「引号内文本」朗读分类助手。
用户会给出当前行原文，以及按顺序提取的引号内文本列表。请对每一条判断应如何朗读：

1. kind = "narration"（非对白 / 旁白）：引号内不是角色说出来的话，而是旁白中的强调、术语、招式名、书名、反话、借用等；或无法当作对白朗读的内容。
2. kind = "male" | "female" | "unknown"（对白）：角色说出来的话。无法确定性别时用 "unknown"。

说话人 speaker：若对白且能对应角色表中的 displayName，填该名（可用别名推断，但输出必须是角色表 displayName）；否则填 null。
kind 为 "narration" 时 speaker 必须为 null。

注意：
- 引导语可在引号前或后，如「杨过道："…"」或「"…"杨过道。」；也可能没有引导语，两人轮流对话需结合上下文推断。
- 不要仅凭「引号」就假设是对白；强调、术语、招式名等应为 narration。
- 不要自行穷举招式等特例，根据语义判断是否为角色开口说话。

输出必须是单一 JSON 对象，不要 Markdown、不要代码围栏：
{ "quotes": [ { "kind": "narration"|"male"|"female"|"unknown", "speaker": string|null }, ... ] }
quotes 数组长度必须与引号条数相同，顺序一一对应。`;

  const user = `## 角色表
${rosterLines}

## 当前行原文
${req.line.trim()}

## 引号内文本列表（按顺序）
${quoteList}

请输出 JSON。`;

  const { text: raw, usage } = await chatCompletionOnce({
    chat,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens: Math.min(chat.maxTokens, 768),
    temperature: Math.min(chat.temperature, 0.3),
    signal,
  });

  const stripped = stripJsonFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch {
    return { quotes: unknownQuotes(quoteTexts.length), tokenUsage: usage };
  }
  if (!parsed || typeof parsed !== "object") {
    return { quotes: unknownQuotes(quoteTexts.length), tokenUsage: usage };
  }

  const nameSet = buildRosterNameMap(req.roster);
  const record = parsed as Record<string, unknown>;
  const rawQuotes = record.quotes;

  if (Array.isArray(rawQuotes)) {
    const out: VoiceReadQuoteAttribution[] = [];
    for (let i = 0; i < quoteTexts.length; i++) {
      out.push(parseQuoteAttribution(rawQuotes[i], nameSet));
    }
    return { quotes: out, tokenUsage: usage };
  }

  const rawSpeakers = record.speakers;
  if (Array.isArray(rawSpeakers)) {
    return {
      quotes: parseLegacySpeakers(rawSpeakers, quoteTexts.length, nameSet),
      tokenUsage: usage,
    };
  }

  return { quotes: unknownQuotes(quoteTexts.length), tokenUsage: usage };
}

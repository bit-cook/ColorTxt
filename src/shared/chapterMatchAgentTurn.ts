/**
 * 判断 Agent 本轮是否以「生成/调整章节匹配规则」为主（非读整章、非概括剧情）。
 * 与 `CHAPTER_MATCH_RULES_SKILL_ID` 启用状态配合使用。
 */
export function isChapterMatchRuleAgentTurn(
  userText: string,
  chapterMatchSkillEnabled: boolean,
): boolean {
  if (!chapterMatchSkillEnabled) return false;
  const t = userText.trim();
  if (!t) return false;

  if (
    /读(取)?(章节)?原文|整章正文|全文内容|不要读原文|不需要读原文|无须读原文|无需读原文/.test(
      t,
    ) &&
    !/匹配规则|章节匹配/.test(t)
  ) {
    return false;
  }

  if (
    /(概括|总结|梳理|讲了什么|剧情|故事内容|主要内容).{0,40}(本章|这一章|第.{0,6}[章回])/.test(
      t,
    ) &&
    !/匹配规则|章节匹配/.test(t)
  ) {
    return false;
  }

  if (
    /匹配规则/.test(t) &&
    /(概括|总结|梳理|剧情|讲了什么)/.test(t) &&
    !/(生成|写|给|出).{0,8}匹配规则/.test(t)
  ) {
    return false;
  }

  return (
    /章节匹配规则/.test(t) ||
    /(生成|写|给|出|制订|制定|帮忙|帮我).{0,16}匹配规则/.test(t) ||
    /匹配规则.{0,24}(生成|写|给|出|怎么)/.test(t)
  );
}

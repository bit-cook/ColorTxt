/** CommonMark 子集：围栏代码块 + 4 空格 / Tab 缩进式代码块 */

const RE_FENCE_OPEN = /^\s{0,3}(`{3,})(?:\S.*)?$/;
const RE_INDENTED_CODE = /^(\t| {4,})/;

export type MarkdownBlockContextTracker = {
  isInCodeBlock: () => boolean;
  feedLine: (line: string) => void;
};

export function createMarkdownBlockContextTracker(): MarkdownBlockContextTracker {
  let inFenced = false;
  let fenceMarker = "";
  let inIndented = false;

  function feedLine(line: string): void {
    if (inFenced) {
      const close = line.match(/^\s{0,3}(`{3,})\s*$/);
      if (close && close[1]!.length >= fenceMarker.length) {
        inFenced = false;
        fenceMarker = "";
      }
      return;
    }

    const open = line.match(RE_FENCE_OPEN);
    if (open) {
      inFenced = true;
      fenceMarker = open[1]!;
      return;
    }

    if (RE_INDENTED_CODE.test(line)) {
      inIndented = true;
      return;
    }

    if (line.trim().length === 0) {
      return;
    }

    inIndented = false;
  }

  return {
    isInCodeBlock: () => inFenced || inIndented,
    feedLine,
  };
}

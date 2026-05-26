/**
 * transformers.node.mjs 顶层 `import "sharp"`，且 image.js 在 Node 下要求 `sharp.default` 为真。
 * 本 stub 满足加载；仅在真正走图像管线调用 sharp() 时抛错（彩读内置向量/检索为纯文本）。
 */
function sharpStub() {
  throw new Error(
    "ColorTxt 安装包未包含 sharp 图像库；当前构建仅支持文本嵌入。",
  );
}

export default sharpStub;

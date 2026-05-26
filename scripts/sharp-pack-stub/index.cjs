"use strict";

function sharpStub() {
  throw new Error(
    "ColorTxt 安装包未包含 sharp 图像库；当前构建仅支持文本嵌入。",
  );
}

module.exports = sharpStub;
module.exports.default = sharpStub;

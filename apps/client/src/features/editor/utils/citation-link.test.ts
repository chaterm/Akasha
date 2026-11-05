import { describe, expect, it } from "vitest";
import {
  buildCitationHref,
  pickCitationQuote,
  readCitationQuote,
} from "./citation-link";

describe("pickCitationQuote", () => {
  it("取回答最先照搬的段落，跳过重复的目录行", () => {
    const excerpt = [
      "本手册介绍打印助手的安装、同步和版本管理",
      "1.打印助手 安装包下载",
      "2.纸张类型设置",
      "1.打印助手 安装包下载",
      "先下载安装包,根据自己系统",
      "安装驱动; macos 会因为证书未签名弹出提示, 可忽略不影响使用",
      "3.本地同步打印队列",
      "任务 都可在本地暂停,pdf,png,docx.,txt 等",
      "本地确认后,可提交打印任务",
    ].join("\n\n");
    const answer = [
      "打印助手 安装包的下载与使用要点如下：",
      "1. **安装注意**：在 macOS 系统上安装驱动时可能会因证书未签名弹出提示，该提示可忽略，不影响驱动的正常使用。",
      "2. **核心功能**：安装驱动后，支持在本地暂停 PDF、PNG、DOCX、TXT 等任务，本地确认后可提交打印任务。",
    ].join("\n");

    expect(pickCitationQuote([excerpt], answer)).toBe(
      "安装驱动; macos 会因为证书未签名弹出提示, 可忽略不影响使用",
    );
  });

  it("多个小节都被照搬时，取回答开头提到的那个", () => {
    const excerpt = [
      "打印助手 常见问题1",
      "说明：如果关闭双面打印。",
      "解决方案：进入打印设置，点击右上角的齿轮图示，点击“高级选项”，关闭“自动双面”。",
      "打印助手 常见问题3",
      "说明：打印内容偏移。",
      "解决方案：可点击：设置-》帮助中心-》联系支持，输入人工，附上打印样张和设置截图，联系支持进行咨询。",
    ].join("\n\n");
    const answer =
      "若打印内容偏移，建议联系支持。此外，您也可在打印设置点击右上角的齿轮图示，进入“高级选项”中开启或关闭“自动双面”功能。";

    expect(pickCitationQuote([excerpt], answer)).toBe("说明：打印内容偏移。");
  });

  it("优先取包含问题内容的段落", () => {
    const excerpt = [
      "打印助手 常见问题25",
      "说明：如何批量设置纸张。",
      "解决方案：可在添加文件后，点击右下角的预览图示进入预览界面，选择纸张后点击“应用到所有页”。",
      "打印助手 常见问题29",
      "说明：如何去除页面上的页眉。",
      "解决方案：可在添加文件后，点击右下角的预览图示进入预览界面，选择“去页眉”选项进行处理保存。",
    ].join("\n\n");
    const answer =
      "在打印助手中，去除页面上的页眉可通过以下方式实现：在添加文件后，点击右下角的预览图示进入预览界面，选择“去页眉”选项进行处理并保存。";

    expect(pickCitationQuote([excerpt], answer, "如何去除页面上的页眉。")).toBe(
      "说明：如何去除页面上的页眉。",
    );
  });

  it("图片摘录用附件 ID 表示", () => {
    const attachmentId = "00000000-0000-4000-8000-000000000003";
    const excerpt = [
      "### 页面图片 3: image.png",
      `附件 ID: ${attachmentId}`,
      "已有替代文本: IMG_001",
      "图片说明: 打印设置界面，选择 A4 纸张",
    ].join("\n\n");

    const quote = pickCitationQuote([excerpt], "unrelated", "如何打印双面文件");
    expect(quote).toBe(`附件 ID: ${attachmentId}`);
    const url = new URL(buildCitationHref("/p/page", quote!), "https://x.test");
    expect(readCitationQuote(url.searchParams.get("cite"))).toEqual({
      attachmentId,
    });
  });

  it("回答没有照搬原文时取摘录开头", () => {
    expect(pickCitationQuote(["第一段\n\n第二段"], "unrelated")).toBe(
      "第一段",
    );
    expect(pickCitationQuote([], "打印内容偏移")).toBeNull();
  });
});

describe("citation link", () => {
  it("短片段整段放进链接，保留原有查询参数和锚点", () => {
    const href = buildCitationHref(
      "/s/aim/p/roadmap?view=compact#rollout",
      "  部署前，\n需要备份  ",
    );
    const url = new URL(href, "https://example.test");

    expect(url.pathname).toBe("/s/aim/p/roadmap");
    expect(url.hash).toBe("#rollout");
    expect(url.searchParams.get("view")).toBe("compact");
    expect(readCitationQuote(url.searchParams.get("cite"))).toEqual({
      start: "部署前需要备份",
    });
  });

  it("长片段只放首尾两段", () => {
    const quote = `${"甲".repeat(30)}${"乙".repeat(30)}${"丙".repeat(30)}`;
    const url = new URL(
      buildCitationHref("/p/page", quote),
      "https://example.test",
    );

    expect(readCitationQuote(url.searchParams.get("cite"))).toEqual({
      start: "甲".repeat(20),
      end: "丙".repeat(20),
    });
  });

  it("没有参数时返回 null", () => {
    expect(readCitationQuote(null)).toBeNull();
    expect(readCitationQuote("")).toBeNull();
  });
});

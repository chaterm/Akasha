import { describe, expect, it } from "vitest";
import { stripAiTextWrapper } from "./ai-text";

describe("stripAiTextWrapper", () => {
  it("keeps plain markdown untouched", () => {
    const answer = "天空呈蓝色源于瑞利散射。\n\n傍晚则偏红。";

    expect(stripAiTextWrapper(answer)).toBe(answer);
  });

  it("unwraps a serialized text envelope", () => {
    const answer = "第一段。\n\n第二段。";
    const wrapped = JSON.stringify({ text: answer });

    expect(stripAiTextWrapper(wrapped)).toBe(answer);
  });

  it("unescapes quotes inside the envelope", () => {
    const wrapped = JSON.stringify({ text: '他说"蓝色"' });

    expect(stripAiTextWrapper(wrapped)).toBe('他说"蓝色"');
  });

  it("keeps a partially streamed envelope readable", () => {
    expect(stripAiTextWrapper('{"text": "天空呈现蓝')).toBe("天空呈现蓝");
  });

  it("ignores objects that are not a text envelope", () => {
    const json = JSON.stringify({ answer: "x" });

    expect(stripAiTextWrapper(json)).toBe(json);
  });
});

import DOMPurify from "dompurify";
import { markdownToHtml } from "@docmost/editor-ext";
import { memo, useEffect, useMemo, useState } from "react";
import { useComputedColorScheme } from "@mantine/core";

type MarkdownSegment =
  | { type: "html"; html: string }
  | { type: "mermaid"; code: string };

let mermaidSequence = 0;

const defaultSanitize = (html: string): string => DOMPurify.sanitize(html);

const MERMAID_STYLE = { overflowX: "auto", maxWidth: "100%" } as const;

const MermaidDiagram = memo(({ code }: { code: string }) => {
  const colorScheme = useComputedColorScheme();
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setFailed(false);

    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          suppressErrorRendering: true,
          theme: colorScheme === "light" ? "default" : "dark",
        });

        return mermaid.render(`ai-mermaid-${++mermaidSequence}`, code);
      })
      .then((result) => {
        if (!cancelled) setSvg(result.svg);
      })
      .catch(() => {
        // Streamed or invalid diagram source: keep the raw code readable.
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [code, colorScheme]);

  if (failed) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div style={MERMAID_STYLE} dangerouslySetInnerHTML={{ __html: svg }} />
  );
});

MermaidDiagram.displayName = "MermaidDiagram";

function splitMermaidBlocks(html: string): MarkdownSegment[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const segments: MarkdownSegment[] = [];
  let buffer = "";

  const flushBuffer = () => {
    if (!buffer) return;
    segments.push({ type: "html", html: buffer });
    buffer = "";
  };

  doc.body.childNodes.forEach((node) => {
    const element = node.nodeType === 1 ? (node as HTMLElement) : null;
    const codeBlock =
      element?.tagName === "PRE"
        ? element.querySelector("code.language-mermaid")
        : null;

    if (codeBlock) {
      flushBuffer();
      const source = codeBlock.textContent?.trim();
      if (source) segments.push({ type: "mermaid", code: source });
      return;
    }

    buffer += element ? element.outerHTML : (node.textContent ?? "");
  });

  flushBuffer();
  return segments;
}

interface AiMarkdownProps {
  content: string;
  sanitize?: (html: string) => string;
  isStreaming?: boolean;
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
}

/**
 * Renders AI markdown answers, turning fenced mermaid blocks into diagrams.
 * Diagrams render only once the answer stops streaming so partial source does
 * not flash an error.
 */
function AiMarkdown({
  content,
  sanitize = defaultSanitize,
  isStreaming = false,
  onClick,
}: AiMarkdownProps) {
  const html = useMemo(
    () => sanitize(markdownToHtml(content) as string),
    [content, sanitize],
  );

  const segments = useMemo(
    () => (isStreaming ? null : splitMermaidBlocks(html)),
    [html, isStreaming],
  );

  const hasMermaid = segments?.some((segment) => segment.type === "mermaid");

  if (!segments || !hasMermaid) {
    return <div onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return (
    <div onClick={onClick}>
      {segments.map((segment, index) =>
        segment.type === "mermaid" ? (
          <MermaidDiagram key={`mermaid-${index}`} code={segment.code} />
        ) : (
          <div
            key={`html-${index}`}
            style={{ display: "contents" }}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        ),
      )}
    </div>
  );
}

export { AiMarkdown };

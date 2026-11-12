import DOMPurify from "dompurify";
import { markdownToHtml } from "@docmost/editor-ext";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { load, mount, Mounted, parse, registered, detectType } from "pele/lazy";

type MarkdownSegment =
  | { type: "html"; html: string }
  | { type: "mermaid"; code: string };

const defaultSanitize = (html: string): string => DOMPurify.sanitize(html);

const MERMAID_STYLE = { overflowX: "auto", maxWidth: "100%" } as const;

const MermaidDiagram = memo(({ code }: { code: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const diagramRef = useRef<Mounted | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setReady(false);

    let type: ReturnType<typeof detectType> | null = null;
    try {
      type = detectType(code);
    } catch {
      setFailed(true);
      return;
    }

    if (!type || registered(type)) {
      if (!cancelled) setReady(true);
      return;
    }

    const settle = () => {
      if (!cancelled) setReady(true);
    };
    load(type).then(settle, settle);

    return () => {
      cancelled = true;
    };
  }, [code]);

  useEffect(() => {
    if (!ready || failed) return;

    try {
      parse(code);
    } catch {
      diagramRef.current?.destroy();
      diagramRef.current = null;
      setFailed(true);
      return;
    }

    if (diagramRef.current) {
      diagramRef.current.update(code);
      return;
    }
    diagramRef.current = mount(containerRef.current, code);
  }, [code, ready, failed]);

  useEffect(() => () => diagramRef.current?.destroy(), []);

  if (failed) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  }

  return <div ref={containerRef} style={MERMAID_STYLE} />;
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

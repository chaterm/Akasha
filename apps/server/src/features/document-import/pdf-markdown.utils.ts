/** Restore TOC entries that OpenDataLoader joined into Markdown paragraphs. */
export function normalizePdfTableOfContents(markdown: string): string {
  const lines = markdown.split('\n');
  const output: string[] = [];
  let fence: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMarker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMarker) {
      if (!fence) {
        fence = fenceMarker[1];
      } else if (
        fenceMarker[1][0] === fence[0] &&
        fenceMarker[1].length >= fence.length
      ) {
        fence = undefined;
      }
      output.push(line);
      continue;
    }

    output.push(line);
    if (
      fence ||
      !/^#{1,6}\s+(?:目\s*录|table\s+of\s+contents|contents)\s*#*\s*$/i.test(
        line,
      )
    ) {
      continue;
    }

    const entries: { title: string; page: string }[] = [];
    let end = i + 1;
    while (end < lines.length) {
      if (!lines[end].trim()) {
        end++;
        continue;
      }
      const paragraph = lines[end].trim();
      const matches = [
        ...paragraph.matchAll(/(.+?)[.．…·]{3,}\s*(\d+)(?=\s|$)/g),
      ];
      const lastMatch = matches[matches.length - 1];
      // Only transform complete directory lines; leave prose untouched.
      if (
        !lastMatch ||
        lastMatch.index + lastMatch[0].length !== paragraph.length
      ) {
        break;
      }
      entries.push(
        ...matches.map((match) => ({
          title: match[1].trim().replace(/\|/g, '\\|'),
          page: match[2],
        })),
      );
      end++;
    }

    if (entries.length >= 2) {
      output.push(
        '',
        ...entries.map(({ title, page }) => `- ${title} …… ${page}`),
        '',
      );
      i = end - 1;
    }
  }

  return output.join('\n');
}

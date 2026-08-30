import { Fragment, type ReactNode } from "react";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

const headingPattern = /^(#{1,4})\s+(.+)$/;
const unorderedPattern = /^\s*[-*+]\s+(.+)$/;
const orderedPattern = /^\s*\d+[.)]\s+(.+)$/;
const tableDividerPattern = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function inline(value: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }

  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function inlineLines(lines: string[], keyPrefix: string): ReactNode[] {
  return lines.flatMap((line, index) => [
    ...(index > 0 ? [<br key={`${keyPrefix}-br-${index}`} />] : []),
    ...inline(line, `${keyPrefix}-${index}`),
  ]);
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return line.startsWith("```")
    || headingPattern.test(line)
    || unorderedPattern.test(line)
    || orderedPattern.test(line)
    || /^\s*>\s?/.test(line)
    || (line.includes("|") && tableDividerPattern.test(lines[index + 1] ?? ""));
}

export function MarkdownContent({ content, className = "" }: MarkdownContentProps) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index]?.trim()) {
      index += 1;
      continue;
    }

    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const language = line.slice(3).trim().replace(/[^a-zA-Z0-9_+-]/g, "").slice(0, 32);
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`}><code data-language={language || undefined}>{code.join("\n")}</code></pre>,
      );
      continue;
    }

    const heading = line.match(headingPattern);
    if (heading) {
      const level = heading[1]!.length;
      const children = inline(heading[2]!, `heading-${index}`);
      if (level === 1) blocks.push(<h3 key={`heading-${index}`}>{children}</h3>);
      else if (level === 2) blocks.push(<h4 key={`heading-${index}`}>{children}</h4>);
      else blocks.push(<h5 key={`heading-${index}`}>{children}</h5>);
      index += 1;
      continue;
    }

    if (line.includes("|") && tableDividerPattern.test(lines[index + 1] ?? "")) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && Boolean(lines[index]?.trim()) && lines[index]!.includes("|")) {
        rows.push(tableCells(lines[index]!));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-scroll" key={`table-${index}`}>
          <table>
            <thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell, `th-${index}-${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{headers.map((_, cellIndex) => (
                <td key={cellIndex}>{inline(row[cellIndex] ?? "", `td-${index}-${rowIndex}-${cellIndex}`)}</td>
              ))}</tr>
            ))}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    const unordered = line.match(unorderedPattern);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(unorderedPattern);
        if (!match) break;
        items.push(match[1]!);
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `ul-${index}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }

    const ordered = line.match(orderedPattern);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(orderedPattern);
        if (!match) break;
        items.push(match[1]!);
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `ol-${index}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`}>{inlineLines(quoted, `quote-${index}`)}</blockquote>);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && Boolean(lines[index]?.trim()) && !startsBlock(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    if (paragraph.length > 0) {
      blocks.push(<p key={`paragraph-${index}`}>{inlineLines(paragraph, `paragraph-${index}`)}</p>);
      continue;
    }

    blocks.push(<Fragment key={`text-${index}`}>{inline(line, `text-${index}`)}</Fragment>);
    index += 1;
  }

  return <div className={`markdown-content ${className}`.trim()}>{blocks}</div>;
}

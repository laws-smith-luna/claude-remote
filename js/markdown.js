/**
 * Minimal markdown-to-HTML renderer.
 * Handles: code blocks, inline code, bold, italic, links, lists, line breaks.
 */

/** Escape HTML entities */
export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render markdown string to HTML */
export function renderMarkdown(md) {
  if (!md) return "";

  let html = "";
  const lines = md.split("\n");
  let i = 0;
  let inList = false;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      if (inList) { html += "</ul>"; inList = false; }
      const lang = line.trimStart().slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const code = escapeHtml(codeLines.join("\n"));
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      html += `<pre class="code-block"${langAttr}><code>${code}</code></pre>`;
      continue;
    }

    // Table: consecutive lines starting with |
    if (line.trimStart().startsWith("|")) {
      if (inList) { html += "</ul>"; inList = false; }
      const tableLines = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      html += renderTable(tableLines);
      continue;
    }

    // Unordered list
    if (/^(\s*[-*+]\s)/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMarkdown(line.replace(/^\s*[-*+]\s/, ""))}</li>`;
      i++;
      continue;
    }

    // Close list if we're in one and this isn't a list item
    if (inList) {
      html += "</ul>";
      inList = false;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      html += `<h${level + 2}>${inlineMarkdown(headingMatch[2])}</h${level + 2}>`;
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Regular paragraph
    html += `<p>${inlineMarkdown(line)}</p>`;
    i++;
  }

  if (inList) html += "</ul>";
  return html;
}

/** Parse a pipe-delimited row into cell strings */
function parseTableRow(line) {
  // Strip leading/trailing pipes and split
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

/** Check if a row is a separator (e.g. |---|---| or |:---:|---:| ) */
function isSeparatorRow(line) {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/** Render collected table lines into HTML table */
function renderTable(tableLines) {
  if (tableLines.length < 2) {
    // Not enough lines for a table — render as paragraphs
    return tableLines.map((l) => `<p>${inlineMarkdown(l)}</p>`).join("");
  }

  // Detect separator row (usually row index 1)
  let sepIdx = -1;
  for (let j = 1; j < tableLines.length; j++) {
    if (isSeparatorRow(tableLines[j])) { sepIdx = j; break; }
  }

  // Parse alignment from separator
  let alignments = [];
  if (sepIdx >= 0) {
    alignments = parseTableRow(tableLines[sepIdx]).map((c) => {
      if (c.startsWith(":") && c.endsWith(":")) return "center";
      if (c.endsWith(":")) return "right";
      return "left";
    });
  }

  let html = '<div class="md-table-wrap"><table class="md-table">';

  if (sepIdx >= 0) {
    // Rows before separator are header
    html += "<thead>";
    for (let j = 0; j < sepIdx; j++) {
      const cells = parseTableRow(tableLines[j]);
      html += "<tr>";
      cells.forEach((c, ci) => {
        const align = alignments[ci] ? ` style="text-align:${alignments[ci]}"` : "";
        html += `<th${align}>${inlineMarkdown(c)}</th>`;
      });
      html += "</tr>";
    }
    html += "</thead><tbody>";
    for (let j = sepIdx + 1; j < tableLines.length; j++) {
      const cells = parseTableRow(tableLines[j]);
      html += "<tr>";
      cells.forEach((c, ci) => {
        const align = alignments[ci] ? ` style="text-align:${alignments[ci]}"` : "";
        html += `<td${align}>${inlineMarkdown(c)}</td>`;
      });
      html += "</tr>";
    }
    html += "</tbody>";
  } else {
    // No separator — render all as body rows
    html += "<tbody>";
    for (const line of tableLines) {
      const cells = parseTableRow(line);
      html += "<tr>";
      cells.forEach((c) => { html += `<td>${inlineMarkdown(c)}</td>`; });
      html += "</tr>";
    }
    html += "</tbody>";
  }

  html += "</table></div>";
  return html;
}

/** Render inline markdown (bold, italic, code, links) */
function inlineMarkdown(text) {
  let result = escapeHtml(text);

  // Inline code
  result = result.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Bold + italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic
  result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Also support _italic_
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<em>$1</em>");

  // Links — only allow safe schemes (http, https, mailto)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, text, href) => {
      if (/^(https?:|mailto:)/i.test(href)) {
        return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
      }
      return text; // strip unsafe links, keep text
    }
  );

  return result;
}

window.escapeHtml = escapeHtml;
window.renderMarkdown = renderMarkdown;

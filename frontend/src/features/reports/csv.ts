/**
 * CSV export.
 *
 * A traffic authority will want these figures in a spreadsheet, and the honest way
 * to provide that is the data behind the charts rather than a screenshot. Values
 * are quoted and internal quotes doubled per RFC 4180, so a road name containing a
 * comma cannot shift every following column.
 */

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  // CRLF: what spreadsheet software expects from a .csv.
  return lines.join('\r\n');
}

/**
 * Trigger a browser download of `content`.
 *
 * Uses a blob URL and revokes it afterwards; leaving it alive holds the whole
 * string in memory for the life of the document.
 */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

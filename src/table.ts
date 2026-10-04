// 终端表格输出（无图形界面也能核对事件与向量）

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => [...(r[i] ?? '')].length))
  );
  const pad = (text: string, i: number): string => {
    const width = widths[i]!;
    const chars = [...text];
    const visible = chars.length;
    // 中文等宽近似：每个 CJK 字符占 2 列
    let extra = 0;
    for (const ch of chars) {
      if (ch.codePointAt(0)! > 0x2e7f) extra += 1;
    }
    return text + ' '.repeat(Math.max(0, width - visible - extra));
  };
  const line = (cells: string[]): string =>
    '| ' + cells.map((c, i) => pad(c, i)).join(' | ') + ' |';
  const sep =
    '+-' + widths.map((w) => '-'.repeat(w)).join('-+-') + '-+';
  return [sep, line(headers), sep, ...rows.map(line), sep].join('\n');
}

export function vectorLabel(order: string[], vector: number[]): string {
  return '[' + vector.map((v, i) => `${order[i]}=${v}`).join(', ') + ']';
}

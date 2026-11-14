export interface PreviewAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface PreviewAnnotationSelection {
  selector: string;
  tagName: string;
  text: string;
  html: string;
  url: string;
  annotation?: PreviewAnnotationRect;
}

export interface PreviewAnnotationIssue {
  level: 'warning' | 'error';
  message: string;
  source: string;
  line: number;
}

export function normalizePreviewAnnotationRect(value: unknown): PreviewAnnotationRect | null {
  if (!value || typeof value !== 'object') return null;
  const rect = value as Partial<PreviewAnnotationRect>;
  const numbers = [rect.x, rect.y, rect.width, rect.height, rect.viewportWidth, rect.viewportHeight];
  if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))) return null;
  if (rect.viewportWidth! <= 0 || rect.viewportHeight! <= 0 || rect.viewportWidth! > 10_000 || rect.viewportHeight! > 10_000) return null;
  if (rect.x! < 0 || rect.y! < 0 || rect.width! < 4 || rect.height! < 4) return null;
  if (rect.width! > 10_000 || rect.height! > 10_000 || rect.x! + rect.width! > rect.viewportWidth! || rect.y! + rect.height! > rect.viewportHeight!) return null;
  return { x: rect.x!, y: rect.y!, width: rect.width!, height: rect.height!, viewportWidth: rect.viewportWidth!, viewportHeight: rect.viewportHeight! };
}

export function previewAnnotationPrompt(selection: PreviewAnnotationSelection, request: string, issues: PreviewAnnotationIssue[]): string {
  return [
    selection.annotation ? 'Use the attached screenshot and marked viewport coordinates to change this area of the live application.' : 'Change the selected element in the live application preview.',
    selection.tagName ? `Element: ${selection.tagName}${selection.selector ? ` (${selection.selector})` : ''}` : '',
    selection.text ? `Visible text: ${selection.text}` : '',
    selection.url ? `Page: ${selection.url}` : '',
    selection.html ? `Element HTML:\n${selection.html}` : '',
    selection.annotation ? `Annotated viewport area: x=${selection.annotation.x}, y=${selection.annotation.y}, width=${selection.annotation.width}, height=${selection.annotation.height} (viewport ${selection.annotation.viewportWidth}×${selection.annotation.viewportHeight}).` : '',
    issues.length ? `Recent browser errors:\n${issues.map((issue) => `- ${issue.level}: ${issue.message}${issue.source ? ` (${issue.source}${issue.line ? `:${issue.line}` : ''})` : ''}`).join('\n')}` : '',
    `Requested change: ${request}`,
  ].filter(Boolean).join('\n\n');
}


import { Copy } from 'lucide-react';
import { memo, useMemo, type ReactNode } from 'react';
import { isProjectFileHref, parseMarkdown, type Block, type Inline } from '../markdown';
import './markdown.css';

function renderInline(nodes: Inline[], keyPrefix: string, onOpenFile?: (path: string) => void): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case 'text': return node.text;
      case 'br': return <br key={key} />;
      case 'code': return <code key={key} className="md-inline-code">{node.text}</code>;
      case 'strong': return <strong key={key}>{renderInline(node.children, key, onOpenFile)}</strong>;
      case 'em': return <em key={key}>{renderInline(node.children, key, onOpenFile)}</em>;
      case 'del': return <del key={key}>{renderInline(node.children, key, onOpenFile)}</del>;
      case 'link': {
        const localFile = isProjectFileHref(node.href);
        if (localFile && !onOpenFile) return <span key={key}>{renderInline(node.children, key)}</span>;
        return <a key={key} href={node.href} target={!localFile ? '_blank' : undefined} rel={!localFile ? 'noopener noreferrer' : undefined} title={node.href} onClick={localFile && onOpenFile ? (event) => { event.preventDefault(); onOpenFile(node.href); } : undefined}>{renderInline(node.children, key, onOpenFile)}</a>;
      }
    }
  });
}

function renderBlocks(blocks: Block[], keyPrefix: string, onOpenFile?: (path: string) => void): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (block.type) {
      case 'heading': {
        const Tag = `h${Math.min(Math.max(block.level, 1), 6)}` as 'h1';
        return <Tag key={key} className="md-heading">{renderInline(block.children, key, onOpenFile)}</Tag>;
      }
      case 'paragraph': return <p key={key}>{renderInline(block.children, key, onOpenFile)}</p>;
      case 'hr': return <hr key={key} />;
      case 'quote': return <blockquote key={key}>{renderBlocks(block.blocks, key, onOpenFile)}</blockquote>;
      case 'code': return (
        <section className="response-code" key={key}>
          <header>
            <span>{block.language || 'text'}</span>
            <button type="button" title="Copy code" aria-label="Copy code" onClick={() => void navigator.clipboard?.writeText(block.text)}><Copy size={14} /></button>
          </header>
          <pre><code>{block.text}</code></pre>
        </section>
      );
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul';
        return (
          <Tag key={key} {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
            {block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderBlocks(item, `${key}-${itemIndex}`, onOpenFile)}</li>)}
          </Tag>
        );
      }
      case 'table': return (
        <div className="md-table-wrap" key={key}>
          <table>
            <thead>
              <tr>{block.header.map((cell, column) => <th key={column} style={{ textAlign: block.aligns[column] ?? undefined }}>{renderInline(cell, `${key}-h${column}`, onOpenFile)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.aligns[column] ?? undefined }}>{renderInline(cell, `${key}-${rowIndex}-${column}`, onOpenFile)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  });
}

/** An agent reply rendered as formatted text: headings, lists, tables, code cards, emphasis and safe links. */
export const Markdown = memo(function Markdown({ text, onOpenFile }: { text: string; onOpenFile?: (path: string) => void }): ReactNode {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="message-body response-content markdown">{renderBlocks(blocks, 'md', onOpenFile)}</div>;
});

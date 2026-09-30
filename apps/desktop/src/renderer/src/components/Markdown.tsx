import { Copy } from 'lucide-react';
import { memo, useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../markdown';
import './markdown.css';

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case 'text': return node.text;
      case 'br': return <br key={key} />;
      case 'code': return <code key={key} className="md-inline-code">{node.text}</code>;
      case 'strong': return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case 'em': return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'del': return <del key={key}>{renderInline(node.children, key)}</del>;
      case 'link': return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" title={node.href}>{renderInline(node.children, key)}</a>;
    }
  });
}

function renderBlocks(blocks: Block[], keyPrefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (block.type) {
      case 'heading': {
        const Tag = `h${Math.min(Math.max(block.level, 1), 6)}` as 'h1';
        return <Tag key={key} className="md-heading">{renderInline(block.children, key)}</Tag>;
      }
      case 'paragraph': return <p key={key}>{renderInline(block.children, key)}</p>;
      case 'hr': return <hr key={key} />;
      case 'quote': return <blockquote key={key}>{renderBlocks(block.blocks, key)}</blockquote>;
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
            {block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderBlocks(item, `${key}-${itemIndex}`)}</li>)}
          </Tag>
        );
      }
      case 'table': return (
        <div className="md-table-wrap" key={key}>
          <table>
            <thead>
              <tr>{block.header.map((cell, column) => <th key={column} style={{ textAlign: block.aligns[column] ?? undefined }}>{renderInline(cell, `${key}-h${column}`)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: block.aligns[column] ?? undefined }}>{renderInline(cell, `${key}-${rowIndex}-${column}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  });
}

/** An agent reply rendered as formatted text: headings, lists, tables, code cards, emphasis and safe links. */
export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="message-body response-content markdown">{renderBlocks(blocks, 'md')}</div>;
});

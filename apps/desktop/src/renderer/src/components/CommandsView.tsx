import { AlertTriangle, ArrowRight, Copy, Search, TerminalSquare } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { COMMAND_GROUPS, type CommandEntry } from './command-reference';

/**
 * The terminal commands worth knowing, explained for someone who has not used a terminal.
 *
 * A reference rather than a cheat sheet: the point is that a beginner can read an entry and understand not only what
 * to type but why they would, and what it will do to their project when they do.
 */
export function CommandsView({ onOpenTerminal }: { onOpenTerminal?: () => void }): ReactNode {
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return COMMAND_GROUPS;
    // A search matches the command, what it does, or when to use it — someone looking for "search files" should find
    // grep without knowing its name.
    const matches = (entry: CommandEntry): boolean =>
      [entry.name, entry.summary, entry.detail, entry.useWhen, ...entry.examples.map((example) => example.explains)]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    return COMMAND_GROUPS
      .map((group) => ({ ...group, commands: group.commands.filter(matches) }))
      .filter((group) => group.commands.length > 0);
  }, [query]);

  async function copy(line: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(line);
      window.setTimeout(() => setCopied((current) => (current === line ? null : current)), 1_500);
    } catch {
      // A window with the clipboard locked down leaves the line on screen to be selected by hand.
    }
  }

  const found = groups.reduce((total, group) => total + group.commands.length, 0);

  return (
    <div className="page-view">
      <header className="page-header">
        <div>
          <h1>Terminal commands</h1>
          <p>What the common commands do, and when you would reach for them.</p>
        </div>
        {onOpenTerminal && (
          <div className="page-actions">
            <button type="button" className="secondary-button" onClick={onOpenTerminal} title="Open the Terminal to try any of these">
              <TerminalSquare size={14} /> Open the Terminal
            </button>
          </div>
        )}
      </header>

      <div className="command-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a command, or describe what you want to do — “search files”, “undo”"
          aria-label="Search commands"
        />
        {query && <button type="button" className="link-button" onClick={() => setQuery('')}>Clear</button>}
      </div>

      {found === 0 && <p className="empty-list">Nothing here matches “{query}”. Try the name of a command, or a word like “files” or “history”.</p>}

      {groups.map((group) => (
        <section key={group.title} className="command-group">
          <div className="section-title"><TerminalSquare size={16} /><span>{group.title}</span></div>
          <p className="settings-note">{group.note}</p>
          <div className="command-list">
            {group.commands.map((entry) => (
              <article key={entry.name} className="command-card">
                <h3><code>{entry.name}</code><span>{entry.summary}</span></h3>
                <p>{entry.detail}</p>
                <ul className="command-examples">
                  {entry.examples.map((example) => (
                    <li key={example.line}>
                      <code>{example.line}</code>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void copy(example.line)}
                        title="Copy this line"
                        aria-label={`Copy ${example.line}`}
                      >
                        <Copy size={11} /> {copied === example.line ? 'Copied' : 'Copy'}
                      </button>
                      <span className="command-explains"><ArrowRight size={11} /> {example.explains}</span>
                    </li>
                  ))}
                </ul>
                <p className="command-when"><strong>When:</strong> {entry.useWhen}</p>
                {entry.caution && (
                  <p className="command-caution"><AlertTriangle size={13} /> {entry.caution}</p>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

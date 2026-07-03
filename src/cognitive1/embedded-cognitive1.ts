import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  Cognitive1Client,
  Cognitive1Health,
  CognitiveHandoff,
  CognitiveRecall,
  CognitiveSessionStart,
} from './cognitive1-client';

type JsonRecord = Record<string, unknown>;

/**
 * TF-IDF scoring for embedded Cognitive1 search.
 *
 * Provides lightweight relevance-ranked recall without requiring
 * external dependencies or embedding models. Indexes are rebuilt
 * on each recall call from the JSONL files.
 */
class TfIdfIndex {
  private documents: Map<string, JsonRecord> = new Map();
  private termDocFreq: Map<string, number> = new Map();
  private totalDocs = 0;

  add(id: string, record: JsonRecord, text: string): void {
    this.documents.set(id, record);
    this.totalDocs++;

    const terms = tokenize(text);
    const seen = new Set<string>();
    for (const term of terms) {
      if (!seen.has(term)) {
        seen.add(term);
        this.termDocFreq.set(term, (this.termDocFreq.get(term) || 0) + 1);
      }
    }
  }

  /**
   * Search the index and return results sorted by TF-IDF score (descending).
   * Returns up to `limit` results with score > 0.
   */
  search(query: string, limit: number): Array<{ record: JsonRecord; score: number }> {
    if (this.totalDocs === 0) return [];

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    // Compute TF-IDF scores
    const scores = new Map<string, number>();

    for (const [id, record] of this.documents) {
      const docText = recordToText(record);
      const docTerms = tokenize(docText);
      let score = 0;

      for (const qt of queryTerms) {
        const tf = docTerms.filter((t) => t === qt).length / Math.max(1, docTerms.length);
        const df = this.termDocFreq.get(qt) || 0;
        const idf = df > 0 ? Math.log((this.totalDocs + 1) / (df + 1)) + 1 : 0;
        score += tf * idf;
      }

      if (score > 0) {
        scores.set(id, score);
      }
    }

    // Sort by score descending, then limit
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({ record: this.documents.get(id)!, score }));
  }

  clear(): void {
    this.documents.clear();
    this.termDocFreq.clear();
    this.totalDocs = 0;
  }
}

/**
 * File-based embedded Cognitive1 implementation with TF-IDF ranked search.
 *
 * Stores data as JSONL files (sessions, patterns, knowledge, handoffs, recalls)
 * and performs keyword-aware relevance scoring on recall.
 */
export class EmbeddedCognitive1 implements Cognitive1Client {
  private brainPath: string;
  private initialized = false;
  private index = new TfIdfIndex();

  constructor(brainPath: string) {
    this.brainPath = brainPath;
  }

  async health(): Promise<Cognitive1Health> {
    try {
      await this.ensureInitialized();
      return { available: true, detail: `Embedded C1 ready at ${this.brainPath}.` };
    } catch (error) {
      return { available: false, detail: `Embedded C1 error: ${errMsg(error)}` };
    }
  }

  async sessionStart(input: CognitiveSessionStart): Promise<string> {
    await this.ensureInitialized();

    await this.append('sessions.jsonl', {
      timestamp: new Date().toISOString(),
      agent: input.agent,
      project: input.projectPath || 'workspace',
      task: input.task,
    });

    const recentSessions = await this.readRecent('sessions.jsonl', 5);
    const patterns = await this.readRecent('patterns.jsonl', 3);
    return buildBriefing(recentSessions, patterns, input.projectPath);
  }

  async recall(input: CognitiveRecall): Promise<string> {
    await this.ensureInitialized();

    // Log the recall query
    await this.append('recalls.jsonl', {
      timestamp: new Date().toISOString(),
      query: input.query,
      project: input.project,
    });

    // Build TF-IDF index from all data sources
    this.index.clear();

    const sessions = await this.readRecent('sessions.jsonl', 100);
    const patterns = await this.readRecent('patterns.jsonl', 100);
    const knowledge = await this.readRecent('knowledge.jsonl', 100);
    const handoffs = await this.readRecent('handoffs.jsonl', 50);

    for (const s of sessions) {
      this.index.add(`session:${str(s.timestamp)}`, s, recordToText(s));
    }
    for (const p of patterns) {
      this.index.add(`pattern:${str(p.title)}`, p, recordToText(p));
    }
    for (const k of knowledge) {
      this.index.add(`knowledge:${str(k.key)}`, k, recordToText(k));
    }
    for (const h of handoffs) {
      this.index.add(`handoff:${str(h.timestamp)}`, h, recordToText(h));
    }

    const query = input.query;
    const results = this.index.search(query, 10);

    if (results.length === 0) {
      // Fall back to substring match as a last resort
      const fallback = this.substringSearch(query, sessions, patterns, knowledge);
      if (fallback.length === 0) {
        return 'No recall results found.';
      }
      return `Recall found ${fallback.length} result(s) [substring match]: ${fallback.join('; ')}`;
    }

    const formatted = results.map((r, i) => {
      const score = r.score.toFixed(2);
      const prefix = classifyRecord(r.record);
      const text = summarize(r.record, 120);
      return `[${prefix}] (${score}) ${text}`;
    });

    return `Recall found ${formatted.length} relevant result(s): ${formatted.join(' | ')}`;
  }

  async handoff(input: CognitiveHandoff): Promise<string> {
    await this.ensureInitialized();

    await this.append('handoffs.jsonl', {
      timestamp: new Date().toISOString(),
      from_agent: input.fromAgent,
      to_agent: input.toAgent,
      summary: input.summary,
      project: input.projectPath,
    });

    return `Handoff recorded from ${input.fromAgent} to ${input.toAgent}.`;
  }

  async learn(pattern: {
    title: string;
    description: string;
    tags?: string[];
  }): Promise<string> {
    await this.ensureInitialized();

    await this.append('patterns.jsonl', {
      timestamp: new Date().toISOString(),
      title: pattern.title,
      description: pattern.description,
      tags: pattern.tags || [],
    });

    return `Pattern "${pattern.title}" saved.`;
  }

  async addKnowledge(entry: { key: string; value: string }): Promise<string> {
    await this.ensureInitialized();

    await this.append('knowledge.jsonl', {
      timestamp: new Date().toISOString(),
      key: entry.key,
      value: entry.value,
    });

    return `Knowledge "${entry.key}" saved.`;
  }

  /**
   * Built-in deduplication: removes entries that are very similar
   * to existing ones (>80% Jaccard similarity on tokenized text).
   */
  async deduplicate(): Promise<{ removed: number }> {
    await this.ensureInitialized();
    let removed = 0;

    for (const filename of [
      'patterns.jsonl',
      'knowledge.jsonl',
    ]) {
      const records = await this.readAll(filename);
      if (records.length < 2) continue;

      const unique: JsonRecord[] = [];
      const seen = new Set<string>();

      for (const record of records) {
        const text = recordToText(record).toLowerCase();
        const tokens = new Set(tokenize(text));
        const sig = [...tokens].sort().join('|');

        let isDuplicate = false;
        for (const existing of seen) {
          const existingTokens = new Set(existing.split('|'));
          const intersection = [...tokens].filter((t) => existingTokens.has(t)).length;
          const union = new Set([...tokens, ...existingTokens]).size;
          const jaccard = union > 0 ? intersection / union : 0;

          if (jaccard > 0.8) {
            isDuplicate = true;
            break;
          }
        }

        if (!isDuplicate) {
          unique.push(record);
          seen.add(sig);
        } else {
          removed++;
        }
      }

      if (removed > 0) {
        // Rewrite the file with deduplicated records
        const filePath = path.join(this.brainPath, filename);
        const content = unique.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await fs.writeFile(filePath, content, 'utf8');
      }
    }

    return { removed };
  }

  private substringSearch(
    query: string,
    sessions: JsonRecord[],
    patterns: JsonRecord[],
    knowledge: JsonRecord[],
  ): string[] {
    const q = query.toLowerCase();
    const relevant: string[] = [];

    for (const s of sessions) {
      if (matchesQuery(s, q)) {
        relevant.push(`[session] ${str(s.agent)}: ${trunc(str(s.task), 100)}`);
      }
    }
    for (const p of patterns) {
      if (matchesQuery(p, q)) {
        relevant.push(
          `[pattern] ${str(p.title ?? p.pattern)}: ${trunc(str(p.description ?? p.content), 100)}`,
        );
      }
    }
    for (const k of knowledge) {
      if (matchesQuery(k, q)) {
        relevant.push(
          `[knowledge] ${str(k.title ?? k.key)}: ${trunc(str(k.content ?? k.value), 100)}`,
        );
      }
    }

    return relevant;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.brainPath, { recursive: true });
    this.initialized = true;
  }

  private async append(filename: string, record: JsonRecord): Promise<void> {
    const filePath = path.join(this.brainPath, filename);
    await fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
  }

  private async readRecent(
    filename: string,
    limit: number,
  ): Promise<JsonRecord[]> {
    const records = await this.readAll(filename);
    return records.slice(-limit).reverse();
  }

  private async readAll(filename: string): Promise<JsonRecord[]> {
    const filePath = path.join(this.brainPath, filename);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return [];
    }

    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as JsonRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is JsonRecord => r !== null);
  }
}

// ---- Helpers ----

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function recordToText(record: JsonRecord): string {
  return Object.values(record)
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
}

function classifyRecord(record: JsonRecord): string {
  if (record.task !== undefined) return 'session';
  if (record.tags !== undefined || record.title !== undefined) return 'pattern';
  if (record.key !== undefined && record.value !== undefined) return 'knowledge';
  if (record.from_agent !== undefined) return 'handoff';
  return 'entry';
}

function summarize(record: JsonRecord, maxLen: number): string {
  const text = record.task || record.title || record.key || record.summary || JSON.stringify(record);
  return trunc(String(text), maxLen);
}

function buildBriefing(
  sessions: JsonRecord[],
  patterns: JsonRecord[],
  projectPath?: string,
): string {
  const project = projectPath ? path.basename(projectPath) : 'workspace';
  const parts: string[] = [`Briefing for ${project}.`];

  if (sessions.length > 0) {
    const list = sessions
      .map((s) => `${str(s.agent)}: ${trunc(str(s.task), 60)}`)
      .join(' | ');
    parts.push(`Last ${sessions.length} session(s): ${list}`);
  }

  if (patterns.length > 0) {
    const list = patterns
      .map((p) => str(p.title ?? p.pattern))
      .filter(Boolean)
      .join(', ');
    parts.push(`Recent patterns: ${list}`);
  }

  return parts.join('\n');
}

function matchesQuery(record: JsonRecord, query: string): boolean {
  const searchable = Object.values(record)
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return searchable.includes(query);
}

function trunc(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

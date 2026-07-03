export interface DiffApplier {
  applyDiff(filePath: string, diff: string): Promise<{ applied: boolean; detail: string }>;
}

export class NoopDiffApplier implements DiffApplier {
  async applyDiff(filePath: string, _diff: string): Promise<{ applied: boolean; detail: string }> {
    return { applied: true, detail: `Dry-run: would apply diff to ${filePath}.` };
  }
}

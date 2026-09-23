import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ServiceKind } from '@kai/contracts';

export interface EngineManifest {
  kind: ServiceKind;
  label: string;
  packageName: string;
  expectedVersion: string;
  expectedCommit: string;
  directoryNames: string[];
  entryPoint: string;
  environmentVariable: string;
}

export interface EngineInstallation {
  kind: ServiceKind;
  label: string;
  root: string;
  entryPoint: string;
  version: string;
  commit: string;
  source: 'environment' | 'bundled' | 'development';
}

export interface EngineLocatorOptions {
  kaiRoot: string;
  resourcesPath: string;
  environment?: NodeJS.ProcessEnv;
}

export const cognitive1Manifest: EngineManifest = {
  kind: 'cognitive1',
  label: 'Cognitive1',
  packageName: 'cognitive1',
  expectedVersion: '1.0.0',
  expectedCommit: '51f6797740c16d1b3df5ddcb24393eb6197c2ce4',
  directoryNames: ['cognitive1'],
  entryPoint: path.join('out', 'index.js'),
  environmentVariable: 'KAI_COGNITIVE1_ENGINE_ROOT',
};

export const universalProxyManifest: EngineManifest = {
  kind: 'universalProxy',
  label: 'Universal Agent Proxy',
  packageName: 'universal-agent-proxy',
  expectedVersion: '1.9.0',
  expectedCommit: 'a8c2443dee3e9c8d268475fe6387cc25fd67a0bb',
  directoryNames: ['universal-agent-proxy', 'ClaudeCode-Proxy'],
  entryPoint: path.join('out', 'proxy.js'),
  environmentVariable: 'KAI_UAP_ENGINE_ROOT',
};

export class EngineLocator {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly options: EngineLocatorOptions) {
    this.environment = options.environment ?? process.env;
  }

  async locate(manifest: EngineManifest): Promise<EngineInstallation> {
    const candidates: Array<{ root: string; source: EngineInstallation['source'] }> = [];
    const configuredRoot = this.environment[manifest.environmentVariable];
    if (configuredRoot) candidates.push({ root: path.resolve(configuredRoot), source: 'environment' });

    for (const directoryName of manifest.directoryNames) {
      candidates.push({
        root: path.join(this.options.resourcesPath, 'engines', directoryName),
        source: 'bundled',
      });
      candidates.push({
        root: path.join(this.options.kaiRoot, 'vendor', 'engines', directoryName),
        source: 'bundled',
      });
      candidates.push({
        root: path.resolve(this.options.kaiRoot, '..', directoryName),
        source: 'development',
      });
    }

    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        return await this.inspect(manifest, candidate.root, candidate.source);
      } catch (error) {
        failures.push(`${candidate.root}: ${messageOf(error)}`);
      }
    }

    throw new Error(
      `${manifest.label} ${manifest.expectedVersion} was not found. ` +
        `Set ${manifest.environmentVariable} or stage the engine in the KAI resources directory.\n` +
        failures.join('\n'),
    );
  }

  private async inspect(
    manifest: EngineManifest,
    root: string,
    source: EngineInstallation['source'],
  ): Promise<EngineInstallation> {
    const packagePath = path.join(root, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (packageJson.name !== manifest.packageName) {
      throw new Error(`expected package ${manifest.packageName}, found ${String(packageJson.name)}`);
    }
    if (packageJson.version !== manifest.expectedVersion) {
      throw new Error(`expected version ${manifest.expectedVersion}, found ${String(packageJson.version)}`);
    }

    const entryPoint = path.join(root, manifest.entryPoint);
    await fs.access(entryPoint);
    return {
      kind: manifest.kind,
      label: manifest.label,
      root,
      entryPoint,
      version: manifest.expectedVersion,
      commit: manifest.expectedCommit,
      source,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

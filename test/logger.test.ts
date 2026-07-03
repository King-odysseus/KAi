import { describe, expect, it, vi } from 'vitest';

// Mock vscode before importing the module under test
vi.mock('vscode', () => {
  const mockChannel = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  };

  const mkChannel = vi.fn(() => mockChannel);

  return {
    window: {
      createOutputChannel: mkChannel,
      showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    },
    LogOutputChannel: class {},
  };
});

import { KaiLogger, initLogger, getLogger } from '../src/core/logger';
import * as vscode from 'vscode';

describe('KaiLogger', () => {
  it('creates a new logger instance', () => {
    const logger = new KaiLogger('test-channel');
    expect(logger).toBeDefined();
    logger.dispose();
  });

  it('logs entries at different severity levels without throwing', () => {
    const logger = new KaiLogger('test-channel', { showUserThreshold: 'error' });
    expect(() => {
      logger.debug('internal', 'debug message');
      logger.info('internal', 'info message');
      logger.warn('agent_unavailable', 'warning message');
      logger.error('agent_crash', 'error message', 'details here', new Error('boom'));
    }).not.toThrow();
    logger.dispose();
  });

  it('buffers log entries', () => {
    const logger = new KaiLogger('test-channel', { showUserThreshold: 'error' });
    logger.info('internal', 'test message');
    const logs = logger.getRecentLogs();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[logs.length - 1].message).toBe('test message');
    logger.dispose();
  });

  it('errorAndThrow returns an Error with the message', () => {
    const logger = new KaiLogger('test-channel', { showUserThreshold: 'error' });
    const err = logger.errorAndThrow('agent_crash', 'fail');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('fail');
    logger.dispose();
  });

  it('getLogger returns singleton after initLogger', () => {
    initLogger('singleton-test');
    const a = getLogger();
    const b = getLogger();
    expect(a).toBe(b);
    a.dispose();
  });
});

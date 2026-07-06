import { describe, expect, it } from 'vitest';
import {
  basename,
  findOverride,
  isOverridingSystem,
  isSensitiveKey,
  isValidEnvVarName,
} from './envVars';

type Summaries = Record<
  string,
  { entries: ReadonlyArray<{ key: string; value: string }> }
>;

describe('isSensitiveKey', () => {
  it('flags common secret-bearing names (case-insensitive)', () => {
    expect(isSensitiveKey('API_TOKEN')).toBe(true);
    expect(isSensitiveKey('my_secret')).toBe(true);
    expect(isSensitiveKey('DB_PASSWORD')).toBe(true);
    expect(isSensitiveKey('AWS_PRIVATE_KEY')).toBe(true);
  });

  it('does not flag ordinary names', () => {
    expect(isSensitiveKey('PATH')).toBe(false);
    expect(isSensitiveKey('HOME')).toBe(false);
    expect(isSensitiveKey('LANG')).toBe(false);
  });
});

describe('isOverridingSystem', () => {
  const sys = { PATH: '/bin', HOME: '/home/u' };

  it('is true when the trimmed key exists in system vars', () => {
    expect(isOverridingSystem('PATH', sys)).toBe(true);
    expect(isOverridingSystem('  HOME  ', sys)).toBe(true);
  });

  it('is false for unknown or empty keys', () => {
    expect(isOverridingSystem('NOPE', sys)).toBe(false);
    expect(isOverridingSystem('', sys)).toBe(false);
    expect(isOverridingSystem('   ', sys)).toBe(false);
  });

  it('does not match inherited Object.prototype keys', () => {
    expect(isOverridingSystem('toString', sys)).toBe(false);
    expect(isOverridingSystem('hasOwnProperty', sys)).toBe(false);
  });
});

describe('basename', () => {
  it('extracts the file name from unix and windows paths', () => {
    expect(basename('/home/u/.env')).toBe('.env');
    expect(basename('C:\\Users\\u\\project\\.env.local')).toBe('.env.local');
    expect(basename('plain')).toBe('plain');
  });
});

describe('isValidEnvVarName', () => {
  it('accepts POSIX-style names', () => {
    expect(isValidEnvVarName('FOO')).toBe(true);
    expect(isValidEnvVarName('_x')).toBe(true);
    expect(isValidEnvVarName('Mixed_123')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidEnvVarName('')).toBe(false);
    expect(isValidEnvVarName('1FOO')).toBe(false);
    expect(isValidEnvVarName('HAS SPACE')).toBe(false);
    expect(isValidEnvVarName('HAS-DASH')).toBe(false);
    expect(isValidEnvVarName('HAS=EQ')).toBe(false);
  });
});

describe('findOverride', () => {
  const paths = ['/a.env', '/b.env', '/c.env'];

  it('reports the most-recent earlier file that defines the key', () => {
    const summaries: Summaries = {
      '/a.env': { entries: [{ key: 'FOO', value: 'from-a' }] },
      '/b.env': { entries: [{ key: 'FOO', value: 'from-b' }] },
      '/c.env': { entries: [{ key: 'FOO', value: 'from-c' }] },
    };
    expect(findOverride('FOO', '/c.env', {}, paths, summaries)).toEqual({
      value: 'from-b',
      source: 'file',
      filePath: '/b.env',
    });
  });

  it('falls back to the system layer when no earlier file matches', () => {
    const summaries: Summaries = {
      '/a.env': { entries: [{ key: 'OTHER', value: 'x' }] },
    };
    expect(
      findOverride('FOO', '/b.env', { FOO: 'sys' }, paths, summaries),
    ).toEqual({ value: 'sys', source: 'system' });
  });

  it('returns the empty-string system value when the key exists but is empty', () => {
    const summaries: Summaries = {};
    expect(
      findOverride('FOO', '/b.env', { FOO: '' }, paths, summaries),
    ).toEqual({ value: '', source: 'system' });
  });

  it('returns null when nothing overrides the key', () => {
    const summaries: Summaries = {
      '/a.env': { entries: [{ key: 'OTHER', value: 'x' }] },
    };
    expect(findOverride('FOO', '/c.env', {}, paths, summaries)).toBeNull();
  });

  it('skips earlier files with no summary and keeps walking', () => {
    const summaries: Summaries = {
      '/a.env': { entries: [{ key: 'FOO', value: 'from-a' }] },
      // '/b.env' has no summary → skipped by the `!prev` guard
    };
    expect(findOverride('FOO', '/c.env', {}, paths, summaries)).toEqual({
      value: 'from-a',
      source: 'file',
      filePath: '/a.env',
    });
  });
});

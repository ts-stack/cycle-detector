import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const TMP_DIR = path.resolve(__dirname, 'tmp-test-sandbox');
const CLI_PATH = path.resolve(process.cwd(), 'dist/index.js');

interface CLIResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecSyncError extends Error {
  status?: number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function createFixture(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

function runCLI(args: string): CLIResult {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      cwd: TMP_DIR,
      stdio: 'pipe',
      env: { ...process.env },
    });
    return { code: 0, stdout: stdout.toString(), stderr: '' };
  } catch (error) {
    const execError = error as ExecSyncError;
    return {
      code: execError.status ?? 1,
      stdout: execError.stdout ? execError.stdout.toString() : '',
      stderr: execError.stderr ? execError.stderr.toString() : '',
    };
  }
}

describe('Circular Dependency Detector CLI', () => {
  beforeEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  describe('Single Repository Mode', () => {
    it('should pass if there are no circular dependencies', () => {
      createFixture(path.join(TMP_DIR, 'tsconfig.json'), '{}');
      createFixture(path.join(TMP_DIR, 'src/index.ts'), "import { b } from './b';");
      createFixture(path.join(TMP_DIR, 'src/b.ts'), 'export const b = 42;');

      const result = runCLI('src/index.ts');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
      expect(result.stdout).toContain('All packages checked');
    });

    it('should fail and detect direct cycle A -> B -> A', () => {
      createFixture(path.join(TMP_DIR, 'tsconfig.json'), '{}');
      createFixture(path.join(TMP_DIR, 'src/index.ts'), "import './b';");
      createFixture(path.join(TMP_DIR, 'src/b.ts'), "import './index';");

      const result = runCLI('src/index.ts');

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Found 1 critical circular dependencies');
      expect(result.stderr).toContain('Validation failed');
    });

    it('should ignore type-only imports in circular checks', () => {
      createFixture(path.join(TMP_DIR, 'tsconfig.json'), '{}');
      createFixture(path.join(TMP_DIR, 'src/index.ts'), "import type { BType } from './b';");
      createFixture(path.join(TMP_DIR, 'src/b.ts'), "import './index';");

      const result = runCLI('src/index.ts');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });
  });

  describe('Monorepo Mode & Correct Cycle Attribution', () => {
    beforeEach(() => {
      createFixture(
        path.join(TMP_DIR, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@monorepo/core': ['packages/core/src/index.ts'],
              '@monorepo/rest': ['packages/rest/src/index.ts'],
            },
          },
        }),
      );

      createFixture(
        path.join(TMP_DIR, 'packages/core/package.json'),
        JSON.stringify({ name: '@monorepo/core', main: 'src/index.ts' }),
      );
      createFixture(path.join(TMP_DIR, 'packages/core/src/index.ts'), "import { restInit } from '@monorepo/rest';");

      createFixture(
        path.join(TMP_DIR, 'packages/rest/package.json'),
        JSON.stringify({ name: '@monorepo/rest', main: 'src/index.ts' }),
      );
      createFixture(
        path.join(TMP_DIR, 'packages/rest/src/index.ts'),
        "import './internal'; export const restInit = () => {};",
      );
      createFixture(path.join(TMP_DIR, 'packages/rest/src/internal.ts'), "import './utils';");
      createFixture(path.join(TMP_DIR, 'packages/rest/src/utils.ts'), "import './internal';");
    });

    it('should correctly attribute internal rest cycles to rest package, leaving core clean', () => {
      const result = runCLI('"packages/*/src"');

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('✅');
      expect(result.stderr).toContain('packages/rest/src/index.ts — Found 1 critical circular dependencies:');
      expect(result.stderr).toContain('packages/rest/src/internal.ts');
      expect(result.stderr).toContain('packages/rest/src/utils.ts');
    });
  });

  describe('Class Fields Evaluation (Lazy vs Static)', () => {
    it('should pass (Clean) if a cycle goes through a non-static class property', () => {
      createFixture(path.join(TMP_DIR, 'tsconfig.json'), '{}');

      // index.ts -> b.ts (лінивий виклик через функцію)
      createFixture(
        path.join(TMP_DIR, 'src/index.ts'),
        "import { B } from './b'; export function getB() { return B; }",
      );
      // b.ts -> index.ts (лінивий виклик через звичайну властивість інстансу класу)
      createFixture(path.join(TMP_DIR, 'src/b.ts'), "import { A } from './index'; export class B { prop = A; }");

      const result = runCLI('src/index.ts');

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should fail (Critical) if a cycle goes through a static class property', () => {
      createFixture(path.join(TMP_DIR, 'tsconfig.json'), '{}');

      // index.ts -> b.ts (лінивий виклик через функцію)
      createFixture(
        path.join(TMP_DIR, 'src/index.ts'),
        "import { B } from './b'; export function getB() { return B; }",
      );
      // b.ts -> index.ts (КРИТИЧНИЙ виклик, бо static виконується top-level в момент імпорту)
      createFixture(path.join(TMP_DIR, 'src/b.ts'), "import { A } from './index'; export class B { static prop = A; }");

      const result = runCLI('src/index.ts');

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Critical circular dependencies detected');
      expect(result.stderr).toContain('Validation failed');
    });
  });
});

import fs from 'node:fs';
import pathUtil from 'node:path';
import { execSync } from 'node:child_process';
import type { TsConfigJson, PackageJson } from 'type-fest';

const __dirname = pathUtil.dirname(new URL(import.meta.url).pathname);
const TMP_DIR = pathUtil.resolve(__dirname, 'tmp-test-sandbox');
const CLI_PATH = pathUtil.resolve(process.cwd(), 'dist/index.js');

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

function createFixture(path: string, content: string): void {
  const filePath = pathUtil.join(TMP_DIR, path);
  const dir = pathUtil.dirname(filePath);
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

describe('Circular Dependency Detector CLI — Comprehensive Suite', () => {
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

  describe('1. Core Graph & Basic Circularity', () => {
    it('should pass if there are no circular dependencies', () => {
      createFixture('tsconfig.json', '{}');
      createFixture('src/index.ts', "import { b } from './b';");
      createFixture('src/b.ts', 'export const b = 42;');

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should fail and detect direct cycle A -> B -> A', () => {
      createFixture('tsconfig.json', '{}');
      createFixture('src/index.ts', "import './b';");
      createFixture('src/b.ts', "import './index';");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Found 1 critical circular dependencies');
    });

    it('should ignore type-only imports in circular checks', () => {
      createFixture('tsconfig.json', '{}');
      createFixture('src/index.ts', "import type { BType } from './b';");
      createFixture('src/b.ts', "import './index';");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });
  });

  describe('2. AST Protection Layers (Avoiding False Positives)', () => {
    beforeEach(() => {
      createFixture('tsconfig.json', '{}');
    });

    it('should pass (Clean) when using mixed imports where the inline "type" token is used, and runtime token is NOT executed on top-level', () => {
      // index.ts -> b.ts
      createFixture(
        'src/index.ts',
        `import { type InlineType, runtimeAsset } from './b';
         
         const user: InlineType = 'admin'; 
         
         export function test() {
           console.log(runtimeAsset);
         }
         export const A = 1;`,
      );
      // b.ts -> index.ts
      createFixture(
        'src/b.ts',
        `import { A } from './index'; 
         export type InlineType = 'admin' | 'user';
         export const runtimeAsset = 42;`,
      );

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should fail (Critical) when using mixed imports if the runtime token is executed or referenced on top-level', () => {
      // index.ts -> b.ts
      createFixture(
        'src/index.ts',
        `import { type InlineType, runtimeAsset } from './b';
         
         const role: InlineType = 'user';
         console.log(runtimeAsset);
         
         export const A = 1;`,
      );
      // b.ts -> index.ts
      createFixture(
        'src/b.ts',
        `import { A } from './index'; 
         export type InlineType = 'admin' | 'user';
         export const runtimeAsset = 100;`,
      );

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Critical circular dependencies detected');
    });

    it('should pass (Clean) when imported token is used strictly inside Type Contexts (Aliases/Interfaces)', () => {
      // index.ts -> b.ts
      createFixture(
        'src/index.ts',
        `import { BInterface } from './b';
         export type LocalType = BInterface;
         export interface Extension extends BInterface { field: string; }
         export const A = 1;`,
      );
      // b.ts -> index.ts
      createFixture('src/b.ts', "import { A } from './index'; export interface BInterface { val: number; }");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should pass (Clean) when identifier matches a safe object property access (obj.token)', () => {
      // index.ts -> b.ts
      createFixture(
        'src/index.ts',
        `import { target } from './b';
         const obj = { target: 'local_value' };
         console.log(obj.target); // 'target' is a property name here, not the imported asset execution
         export const A = 1;`,
      );
      // b.ts -> index.ts
      createFixture('src/b.ts', "import { A } from './index'; export const target = () => {};");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should pass (Clean) when identifier matches an object literal assignment key ({ token: 123 })', () => {
      // index.ts -> b.ts
      createFixture(
        'src/index.ts',
        `import { target } from './b';
         const config = { target: 100 }; // Key name matching, completely safe at top-level
         export const A = 1;`,
      );
      // b.ts -> index.ts
      createFixture('src/b.ts', "import { A } from './index'; export const target = 42;");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should pass (Clean) if a declaration shadows the imported token name', () => {
      // index.ts -> b.ts
      createFixture(
        'src/index.ts',
        `import { shadowed } from './b';
         class Test {
           shadowed() {} // Method declaration name protection
         }
         export const A = 1;`,
      );
      // b.ts -> index.ts
      createFixture('src/b.ts', "import { A } from './index'; export const shadowed = 1;");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });
  });

  describe('3. Hoisting & Advanced Export Behaviors', () => {
    beforeEach(() => {
      createFixture('tsconfig.json', '{}');
    });

    it('should pass (Clean) if top-level uses an explicit hoisted default function declaration', () => {
      // index.ts -> b.ts
      createFixture('src/index.ts', "import bDefault from './b'; bDefault(); export const A = 1;");
      // b.ts -> index.ts
      createFixture('src/b.ts', "import { A } from './index'; export default function hoistedDefault() {}");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should fail (Critical) if top-level uses a non-hoisted default expression (TDZ Risk)', () => {
      // index.ts -> b.ts
      createFixture('src/index.ts', "import bDefault from './b'; bDefault(); export const A = 1;");
      // b.ts -> index.ts
      createFixture('src/b.ts', "import { A } from './index'; export default () => {};"); // Arrow function expressions aren't hoisted

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Critical circular dependencies detected');
    });

    it('should pass (Clean) if a local function is hoisted and exported via standalone assignment', () => {
      // index.ts -> b.ts
      createFixture('src/index.ts', "import { target } from './b'; target(); export const A = 1;");
      // b.ts -> index.ts
      createFixture(
        'src/b.ts',
        `import { A } from './index';
         function localFunc() {}
         export { localFunc as target };`,
      );

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should pass (Clean) if a namespace property access points to a hoisted function (ns.foo())', () => {
      // index.ts -> b.ts
      createFixture('src/index.ts', "import * as bNs from './b'; bNs.hoisted(); export const A = 1;");
      // b.ts -> index.ts
      createFixture('src/b.ts', "import { A } from './index'; export function hoisted() {}");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should fail (Critical) if a namespace property access points to a non-hoisted constant', () => {
      // index.ts -> b.ts
      createFixture('src/index.ts', "import * as bNs from './b'; bNs.constantClosure(); export const A = 1;");
      // b.ts -> index.ts
      createFixture('src/b.ts', "import { A } from './index'; export const constantClosure = () => {};");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Critical circular dependencies detected');
    });

    it('should fail (Critical) on runtime re-exports (export { x } from "./b")', () => {
      // index.ts -> b.ts
      createFixture('src/index.ts', "export { bAsset } from './b'; export const A = 1;");
      // b.ts -> index.ts
      createFixture('src/b.ts', "import { A } from './index'; export const bAsset = 42;");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Critical circular dependencies detected');
    });
  });

  describe('4. Complex Monorepo & Build Artifact Mapping Fallbacks', () => {
    it('should successfully map compiled assets (.js/.d.ts) inside dist back to src to find cross-package cycles', () => {
      createFixture(
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            paths: {
              '@scope/api': ['packages/api/dist/index.d.ts'],
            },
          },
        } satisfies TsConfigJson),
      );

      // Package 1: Gateway
      const gatewayPkg: PackageJson = { name: '@scope/gateway', main: 'src/index.ts' };
      createFixture('packages/gateway/package.json', JSON.stringify(gatewayPkg));
      createFixture(
        'packages/gateway/src/index.ts',
        "import { apiAsset } from '@scope/api'; console.log(apiAsset); export const gatewayAsset = 1;",
      );

      const apiPkg: PackageJson = { name: '@scope/api', main: 'dist/index.js' };
      createFixture('packages/api/package.json', JSON.stringify(apiPkg));
      createFixture('packages/api/dist/index.d.ts', 'export declare const apiAsset: number;');
      createFixture('packages/api/dist/index.js', 'exports.apiAsset = 42;');
      createFixture(
        'packages/api/src/index.ts',
        "import { gatewayAsset } from '../../gateway/src/index'; console.log(gatewayAsset); export const apiAsset = 42;",
      );

      const result = runCLI('"packages/*/src"');

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Critical circular dependencies detected');
      expect(result.stderr).toContain('packages/api/src/index.ts');
    });

    it('should dynamically adapt to alternative naming structures like "source" and "build"', () => {
      createFixture('package.json', JSON.stringify({ name: 'custom-pkg', main: 'build/main.js' }));
      createFixture('tsconfig.json', '{}');

      createFixture('source/main.ts', "import './utils';");
      createFixture('source/utils.ts', "import './main';");

      createFixture('build/main.js', '');
      createFixture('build/utils.js', '');

      const result = runCLI('source/main.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Found 1 critical circular dependencies');
    });
  });
});

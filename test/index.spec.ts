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

  describe('5. Re-export Variants', () => {
    beforeEach(() => {
      createFixture('tsconfig.json', '{}');
    });

    it('should fail (Critical) on export * from "./b" (re-export all) when cycle exists', () => {
      // index.ts re-exports everything from b.ts, b.ts imports from index.ts
      createFixture('src/index.ts', "export * from './b'; export const A = 1;");
      createFixture('src/b.ts', "import { A } from './index'; export const bAsset = 42;");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Critical circular dependencies detected');
    });

    it('should pass (Clean) when the re-export source has no cycle back', () => {
      // index.ts re-exports from b.ts, but b.ts does NOT import from index.ts
      createFixture('src/index.ts', "export * from './b';");
      createFixture('src/b.ts', 'export const bAsset = 42;');

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });
  });

  describe('6. Multi-node Cycles (3+ nodes)', () => {
    beforeEach(() => {
      createFixture('tsconfig.json', '{}');
    });

    it('should pass (Clean) on a 3-node cycle A→B→C→A where ALL usages are lazy (inside functions)', () => {
      // A → B: lazy usage inside a function
      createFixture(
        'src/a.ts',
        `import { b } from './b';
         export function useB() { return b(); }
         export const A = 1;`,
      );
      // B → C: lazy usage inside a function
      createFixture(
        'src/b.ts',
        `import { c } from './c';
         export function b() { return c(); }
         export const B = 2;`,
      );
      // C → A: lazy usage inside a function (closes the cycle)
      createFixture(
        'src/c.ts',
        `import { A } from './a';
         export function c() { return A; }
         export const C = 3;`,
      );

      const result = runCLI('src/a.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should fail (Critical) on a 3-node cycle A→B→C→A where at least one edge has top-level usage', () => {
      // A → B: lazy (inside function)
      createFixture(
        'src/a.ts',
        `import { b } from './b';
         export function useB() { return b(); }
         export const A = 1;`,
      );
      // B → C: lazy (inside function)
      createFixture(
        'src/b.ts',
        `import { c } from './c';
         export function b() { return c(); }
         export const B = 2;`,
      );
      // C → A: CRITICAL — top-level usage of A
      createFixture(
        'src/c.ts',
        `import { A } from './a';
         export const C = A + 10; // top-level execution`,
      );

      const result = runCLI('src/a.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Critical circular dependencies detected');
    });
  });

  describe('7. Class & Decorator Scope Rules', () => {
    beforeEach(() => {
      createFixture('tsconfig.json', '{}');
    });

    it('should fail (Critical) when a static class property uses an imported token at top-level', () => {
      // Static properties are evaluated at class definition time (top-level scope)
      createFixture(
        'src/index.ts',
        `import { value } from './b';
         export class Config {
           static LIMIT = value; // static property = top-level execution
         }
         export const A = 1;`,
      );
      createFixture('src/b.ts', "import { A } from './index'; export const value = 42;");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Critical circular dependencies detected');
    });

    it('should pass (Clean) when an imported token is used only inside a constructor body (lazy)', () => {
      // Constructor bodies are deferred — only executed upon `new ClassName()`
      createFixture(
        'src/index.ts',
        `import { value } from './b';
         export class Service {
           private data: number;
           constructor() {
             this.data = value; // constructor = lazy scope
           }
         }
         export const A = 1;`,
      );
      createFixture('src/b.ts', "import { A } from './index'; export const value = 42;");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should pass (Clean) when an imported token is used only inside a non-static class property (lazy)', () => {
      createFixture(
        'src/index.ts',
        `import { value } from './b';
         export class Widget {
           label = value; // non-static instance property = lazy
         }
         export const A = 1;`,
      );
      createFixture('src/b.ts', "import { A } from './index'; export const value = 99;");

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });
  });

  describe('8. Edge Cases & Resilience', () => {
    it('should pass (Clean) when entry file is empty', () => {
      createFixture('tsconfig.json', '{}');
      createFixture('src/empty.ts', ''); // no imports, no exports

      const result = runCLI('src/empty.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should still work without a tsconfig.json present (graceful fallback)', () => {
      // No tsconfig.json created — tool should use empty compiler options
      createFixture('src/index.ts', "import { b } from './b';");
      createFixture('src/b.ts', 'export const b = 1;');

      const result = runCLI('src/index.ts');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('✅');
    });

    it('should exit with code 1 and error message when no arguments are provided', () => {
      const result = runCLI('');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Error:');
    });

    it('should exit with code 1 when the specified entry file does not exist', () => {
      createFixture('tsconfig.json', '{}');

      const result = runCLI('src/nonexistent.ts');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No entry files found');
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

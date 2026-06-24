import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..'); 

const TMP_DIR = path.resolve(PROJECT_ROOT, '__tmp_tests__');
const CLI_PATH = path.resolve(PROJECT_ROOT, 'dist/index.js');

describe('cycle-detector CLI', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  function runCLI(args: string[], execCwd: string = originalCwd) {
    const result = spawnSync('node', [CLI_PATH, ...args], {
      cwd: execCwd,
      encoding: 'utf8',
    });

    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  function createTsConfig(dir: string, paths: Record<string, string[]> = {}) {
    const config = {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        baseUrl: './',
        paths,
      },
    };
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(config, null, 2));
  }

  test('should pass successfully if there are no circular dependencies', () => {
    const projectDir = path.join(TMP_DIR, 'clean-project');
    fs.mkdirSync(projectDir, { recursive: true });
    createTsConfig(projectDir);

    fs.writeFileSync(path.join(projectDir, 'index.ts'), "import { b } from './b.js';\nconsole.log(b);");
    fs.writeFileSync(path.join(projectDir, 'b.ts'), 'export const b = 42;');

    const { status, stdout } = runCLI([path.join(projectDir, 'index.ts')]);

    expect(status).toBe(0);
    expect(stdout).toContain('Clean!');
    expect(stdout).toContain('No circular dependencies found!');
  });

  test('should detect a direct circular dependency and return exit code 1', () => {
    const projectDir = path.join(TMP_DIR, 'cyclic-project');
    fs.mkdirSync(projectDir, { recursive: true });
    createTsConfig(projectDir);

    fs.writeFileSync(path.join(projectDir, 'index.ts'), "import './b.js';");
    fs.writeFileSync(path.join(projectDir, 'b.ts'), "import './index.js';");

    const { status, stderr } = runCLI([path.join(projectDir, 'index.ts')]);

    expect(status).toBe(1);
    expect(stderr).toMatch(/index\.ts -> .*b\.ts -> .*index\.ts/);
    expect(stderr).toContain('Circular dependencies detected.');
  });

  test('should completely ignore type-only imports', () => {
    const projectDir = path.join(TMP_DIR, 'type-only-project');
    fs.mkdirSync(projectDir, { recursive: true });
    createTsConfig(projectDir);

    fs.writeFileSync(path.join(projectDir, 'index.ts'), "import { B } from './b.js';");
    fs.writeFileSync(path.join(projectDir, 'b.ts'), "import type { IndexType } from './index.js';\nexport class B {}");

    const { status, stdout } = runCLI([path.join(projectDir, 'index.ts')]);

    expect(status).toBe(0);
    expect(stdout).toContain('Clean!');
  });

  test('should correctly analyze monorepo structures using glob patterns', () => {
    const monorepoDir = path.join(TMP_DIR, 'monorepo');
    const pkgADir = path.join(monorepoDir, 'packages/pkg-a/src');
    const pkgBDir = path.join(monorepoDir, 'packages/pkg-b/src');

    fs.mkdirSync(pkgADir, { recursive: true });
    fs.mkdirSync(pkgBDir, { recursive: true });

    createTsConfig(path.dirname(pkgADir));
    createTsConfig(path.dirname(pkgBDir));

    fs.writeFileSync(path.join(pkgADir, 'index.ts'), "import './utils.js';");
    fs.writeFileSync(path.join(pkgADir, 'utils.ts'), 'export const greet = "hi";');

    fs.writeFileSync(path.join(pkgBDir, 'index.ts'), "import './component.js';");
    fs.writeFileSync(path.join(pkgBDir, 'component.ts'), "import './index.js';");

    const { status, stdout, stderr } = runCLI(['packages/*/src/index.ts'], monorepoDir);

    expect(status).toBe(1);
    expect(stdout).toContain('[packages/pkg-a/src/index.ts] — Clean!');
    expect(stderr).toContain('[packages/pkg-b/src/index.ts] — Found 1 circular dependencies');
  });

  test('should respect explicitly provided tsconfig file via --project flag', () => {
    const projectDir = path.join(TMP_DIR, 'custom-config-project');
    fs.mkdirSync(projectDir, { recursive: true });
    
    const customConfigPath = path.join(projectDir, 'tsconfig.custom.json');
    
    createTsConfig(projectDir, { '@/*': ['src/*'] });
    fs.renameSync(path.join(projectDir, 'tsconfig.json'), customConfigPath);

    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'index.ts'), "import '@/b.js';");
    fs.writeFileSync(path.join(srcDir, 'b.ts'), "import '@/index.js';");

    const { status, stderr } = runCLI([path.join(srcDir, 'index.ts'), '--project', customConfigPath]);

    expect(status).toBe(1);
    expect(stderr).toMatch(/index\.ts -> .*b\.ts -> .*index\.ts/);
    expect(stderr).toContain('Circular dependencies detected.');
  });
});

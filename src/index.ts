#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type NodeState = 'VISITING' | 'VISITED';

// Global shared structures for maximum performance
const graph = new Map<string, string[]>();
const allUniqueCycles: string[][] = [];
const globalDetectedCycles = new Set<string>();

const packageMetaCache = new Map<string, { pkgDir: string; srcDirName: string; outDirName: string; } | null>();
const compilerOptionsCache = new Map<string, ts.CompilerOptions>();

let globalProjectPath: string | undefined;

function parseArgs() {
  const args = [...process.argv.slice(2)];
  let projectPath: string | undefined;
  const entryPatterns: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' || args[i] === '-p') {
      projectPath = args[i + 1];
      i++;
    } else {
      entryPatterns.push(args[i]);
    }
  }

  return { entryPatterns, projectPath };
}

function isRuntimeImport(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (!node.moduleSpecifier) return false;
    return !node.isTypeOnly;
  }

  if (ts.isImportDeclaration(node)) {
    if (!node.importClause) return true;
    if (node.importClause.phaseModifier) return false;

    const namedBindings = node.importClause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      return !namedBindings.elements.every((el) => el.isTypeOnly);
    }
    return true;
  }

  return false;
}

function getCompilerOptionsForFile(filePath: string): ts.CompilerOptions {
  const currentDir = path.dirname(filePath);

  const cachedOptions = compilerOptionsCache.get(currentDir);
  if (cachedOptions !== undefined) {
    return cachedOptions;
  }

  const configPath = ts.findConfigFile(currentDir, ts.sys.fileExists, 'tsconfig.json') || globalProjectPath;

  if (configPath) {
    const resolvedConfigPath = path.resolve(configPath);
    const configDir = path.dirname(resolvedConfigPath);

    const cachedConfig = compilerOptionsCache.get(resolvedConfigPath);
    if (cachedConfig !== undefined) {
      compilerOptionsCache.set(currentDir, cachedConfig);
      return cachedConfig;
    }

    try {
      const configFile = ts.readConfigFile(resolvedConfigPath, ts.sys.readFile);
      const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir);
      const options = parsedConfig.options || {};

      compilerOptionsCache.set(resolvedConfigPath, options);
      compilerOptionsCache.set(currentDir, options);
      return options;
    } catch {
      // Fallback
    }
  }

  return {};
}

function getPackageMeta(filePath: string) {
  let currentDir = path.dirname(filePath);
  const visitedDirs: string[] = [];

  while (currentDir && currentDir !== path.parse(currentDir).root) {
    const cached = packageMetaCache.get(currentDir);
    if (cached !== undefined) {
      for (const d of visitedDirs) packageMetaCache.set(d, cached);
      return cached;
    }

    const pkgJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const content = fs.readFileSync(pkgJsonPath, 'utf8');
        const pkg = JSON.parse(content);

        let outDirName = 'dist';
        const mainField = pkg.main || pkg.types || pkg.typings || '';
        if (mainField) {
          const parts = path.normalize(mainField).split(path.sep);
          if (parts.length > 1 && parts[0] !== '.' && parts[0] !== '..') {
            outDirName = parts[0];
          } else if (parts.length > 2 && (parts[0] === '.' || parts[0] === '..')) {
            outDirName = parts[1];
          }
        }

        let srcDirName = 'src';
        if (fs.existsSync(path.join(currentDir, 'source'))) srcDirName = 'source';
        else if (fs.existsSync(path.join(currentDir, 'lib'))) srcDirName = 'lib';

        const meta = { pkgDir: currentDir, srcDirName, outDirName };
        packageMetaCache.set(currentDir, meta);
        for (const d of visitedDirs) packageMetaCache.set(d, meta);
        return meta;
      } catch {
        packageMetaCache.set(currentDir, null);
        for (const d of visitedDirs) packageMetaCache.set(d, null);
        return null;
      }
    }

    visitedDirs.push(currentDir);
    currentDir = path.dirname(currentDir);
  }

  return null;
}

function resolveModule(moduleName: string, containingFile: string, options: ts.CompilerOptions): string | null {
  const result = ts.resolveModuleName(moduleName, containingFile, options, ts.sys);
  if (!result.resolvedModule) return null;

  const resolvedFileName = path.resolve(result.resolvedModule.resolvedFileName);

  if (resolvedFileName.includes(`${path.sep}node_modules${path.sep}`)) {
    return null;
  }

  const meta = getPackageMeta(resolvedFileName);
  if (meta) {
    const { pkgDir, srcDirName, outDirName } = meta;
    const srcDirPath = path.join(pkgDir, srcDirName);

    if (resolvedFileName.startsWith(srcDirPath + path.sep)) {
      return resolvedFileName;
    }

    const outDirPath = path.join(pkgDir, outDirName);
    if (resolvedFileName.startsWith(outDirPath + path.sep) || resolvedFileName === outDirPath) {
      const relativeToOut = path.relative(outDirPath, resolvedFileName);
      let baseName = relativeToOut;

      if (baseName.endsWith('.d.ts')) baseName = baseName.slice(0, -5);
      else if (baseName.endsWith('.d.mts')) baseName = baseName.slice(0, -6);
      else if (baseName.endsWith('.d.cts')) baseName = baseName.slice(0, -6);
      else if (baseName.endsWith('.js')) baseName = baseName.slice(0, -3);
      else if (baseName.endsWith('.mjs')) baseName = baseName.slice(0, -4);
      else if (baseName.endsWith('.cjs')) baseName = baseName.slice(0, -4);
      else if (baseName.endsWith('.jsx')) baseName = baseName.slice(0, -4);

      const extensions = ['.ts', '.tsx', '.mts', '.cts'];
      for (const ext of extensions) {
        const targetSrcFile = path.join(srcDirPath, baseName + ext);
        if (fs.existsSync(targetSrcFile)) {
          return targetSrcFile;
        }
      }
    }
  }

  if (result.resolvedModule.isExternalLibraryImport) {
    return null;
  }

  return resolvedFileName;
}

function getCanonicalCycleKey(cycle: string[]): string {
  const nodes = cycle.slice(0, -1);
  if (nodes.length === 0) return '';

  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIdx]) {
      minIdx = i;
    }
  }

  const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
  rotated.push(rotated[0]);
  return rotated.join('|');
}

function parseFile(filePath: string) {
  if (graph.has(filePath) || !fs.existsSync(filePath)) return;
  graph.set(filePath, []);

  const options = getCompilerOptionsForFile(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];

  function walk(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (isRuntimeImport(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const resolved = resolveModule(specifier.text, filePath, options);
          if (resolved && !imports.includes(resolved)) imports.push(resolved);
        }
      }
    }
    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
  graph.set(filePath, imports);

  for (const dep of imports) parseFile(dep);
}

/**
 * Checks if a specific file import creates an immediate execution (top-level) risk.
 */
function hasTopLevelUsage(fromFile: string, toFile: string): boolean {
  if (!fs.existsSync(fromFile)) return false;

  const options = getCompilerOptionsForFile(fromFile);
  const content = fs.readFileSync(fromFile, 'utf8');
  const sourceFile = ts.createSourceFile(fromFile, content, ts.ScriptTarget.Latest, true);

  const importedSymbols = new Set<string>();
  let hasSideEffectOrReExport = false;

  // 1. Collect all names imported from 'toFile'
  function findImports(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (isRuntimeImport(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const resolved = resolveModule(specifier.text, fromFile, options);
          if (resolved === toFile) {
            if (ts.isImportDeclaration(node) && node.importClause) {
              const clause = node.importClause;
              if (clause.name) importedSymbols.add(clause.name.text); // default import
              if (clause.namedBindings) {
                if (ts.isNamespaceImport(clause.namedBindings)) {
                  importedSymbols.add(clause.namedBindings.name.text); // import * as namespace
                } else if (ts.isNamedImports(clause.namedBindings)) {
                  for (const el of clause.namedBindings.elements) {
                    importedSymbols.add(el.name.text); // named imports
                  }
                }
              }
            } else {
              // Re-exports (export * from...) or side-effect imports (import './file') 
              // trigger top-level evaluation instantly.
              hasSideEffectOrReExport = true;
            }
          }
        }
      }
    }
    ts.forEachChild(node, findImports);
  }

  findImports(sourceFile);

  if (hasSideEffectOrReExport) return true;
  if (importedSymbols.size === 0) return false;

  let dangerousTopLevelUsage = false;

  // 2. Check if collected symbols are used outside of lazy blocks (functions/methods)
  function checkNodeUsage(node: ts.Node, isInsideLazyScope: boolean) {
  if (dangerousTopLevelUsage) return;

  let currentScopeLazy = isInsideLazyScope;

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    currentScopeLazy = true;
  }

  if (ts.isPropertyDeclaration(node)) {
    const isStatic = node.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
    if (!isStatic) {
      currentScopeLazy = true; 
    }
  }

  if (!currentScopeLazy && ts.isIdentifier(node)) {
    if (importedSymbols.has(node.text)) {
      const parent = node.parent;
      
        // Verify it's an actual usage reference, not the import clause definition itself
      const isImportDeclarationRef = 
        ts.isImportSpecifier(parent) || 
        ts.isImportClause(parent) || 
        ts.isNamespaceImport(parent);

      if (!isImportDeclarationRef) {
          // Verify it's not just a TypeScript Type usage context (which is safe in runtime)
        let isInTypeContext = false;
        let checkParent: ts.Node | undefined = parent;
        while (checkParent && checkParent !== sourceFile) {
          if (
            ts.isTypeNode(checkParent) || 
            ts.isTypeReferenceNode(checkParent) || 
            ts.isTypeAliasDeclaration(checkParent) || 
            ts.isInterfaceDeclaration(checkParent)
          ) {
            isInTypeContext = true;
            break;
          }
          checkParent = checkParent.parent;
        }

        if (!isInTypeContext) {
          dangerousTopLevelUsage = true;
          return;
        }
      }
    }
  }

  ts.forEachChild(node, (n) => checkNodeUsage(n, currentScopeLazy));
}

  checkNodeUsage(sourceFile, false);
  return dangerousTopLevelUsage;
}

function canReach(start: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [start];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);

    const deps = graph.get(current) || [];
    for (const dep of deps) {
      stack.push(dep);
    }
  }
  return false;
}

function main() {
  const { entryPatterns, projectPath } = parseArgs();
  globalProjectPath = projectPath;

  if (entryPatterns.length === 0) {
    console.error('❌ Error: Please specify at least one entry point or glob pattern.');
    process.exit(1);
  }

  const entryPoints: string[] = [];

  for (const pattern of entryPatterns) {
    const matches = fs.globSync ? fs.globSync(pattern) : [pattern];

    for (const match of matches) {
      let fullPath = path.resolve(match);

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        const indexTs = path.join(fullPath, 'index.ts');
        const indexTsx = path.join(fullPath, 'index.tsx');
        fullPath = fs.existsSync(indexTs) ? indexTs : indexTsx;
      }

      if (fs.existsSync(fullPath) && !entryPoints.includes(fullPath)) {
        entryPoints.push(fullPath);
      }
    }
  }

  if (entryPoints.length === 0) {
    console.error('❌ Error: No entry files found matching the provided paths or patterns.');
    process.exit(1);
  }

  console.log(`🔍 Found ${entryPoints.length} entry point(s) for analysis. Building graph...\n`);

  // Phase 1: Deep parse all files globally across all entry points
  for (const entryPoint of entryPoints) {
    parseFile(entryPoint);
  }

  // Phase 2: Traverse the global graph to discover all unique cycles
  const visited = new Map<string, NodeState>();
  const currentStack: string[] = [];

  function findCycles(node: string) {
    visited.set(node, 'VISITING');
    currentStack.push(node);

    for (const neighbor of graph.get(node) || []) {
      const state = visited.get(neighbor);
      if (state === 'VISITING') {
        const startIdx = currentStack.indexOf(neighbor);
        const cycle = currentStack.slice(startIdx);
        cycle.push(neighbor);

        const key = getCanonicalCycleKey(cycle);
        if (!globalDetectedCycles.has(key)) {
          globalDetectedCycles.add(key);
          allUniqueCycles.push(cycle);
        }
      } else if (!state) {
        findCycles(neighbor);
      }
    }

    currentStack.pop();
    visited.set(node, 'VISITED');
  }

  for (const entryPoint of entryPoints) {
    if (!visited.has(entryPoint)) {
      findCycles(entryPoint);
    }
  }

  // Phase 2.5: Smart AST Filtering (Filter out runtime-safe / lazy cycles)
  const criticalCycles: string[][] = [];

  for (const cycle of allUniqueCycles) {
    let isHarmfulCycle = false;

    // A cycle is harmful if AT LEAST ONE link in it uses imports on top-level
    for (let i = 0; i < cycle.length - 1; i++) {
      if (hasTopLevelUsage(cycle[i], cycle[i + 1])) {
        isHarmfulCycle = true;
        break;
      }
    }

    if (isHarmfulCycle) {
      criticalCycles.push(cycle);
    }
  }

  // Phase 3: Intelligently distribute critical cycles to their native entry points
  const entryPointCycles = new Map<string, string[][]>();
  for (const ep of entryPoints) {
    entryPointCycles.set(ep, []);
  }

  for (const cycle of criticalCycles) {
    const firstFile = cycle[0];

    const matchedEp = entryPoints.find((ep) => {
      const epDir = path.dirname(ep);
      return firstFile.startsWith(epDir + path.sep) || firstFile === ep;
    });

    if (matchedEp) {
      entryPointCycles.get(matchedEp)!.push(cycle);
    } else {
      const reachingEp = entryPoints.find((ep) => canReach(ep, firstFile));
      if (reachingEp) {
        entryPointCycles.get(reachingEp)!.push(cycle);
      } else {
        entryPointCycles.get(entryPoints[0])!.push(cycle);
      }
    }
  }

  // Phase 4: Output the clean, perfectly targeted report
  let globalHasCycles = false;

  for (const entryPoint of entryPoints) {
    const absoluteEntry = path.resolve(entryPoint);
    const cycles = entryPointCycles.get(entryPoint) || [];

    if (cycles.length > 0) {
      globalHasCycles = true;
      console.error(`❌ [${absoluteEntry}] — Found ${cycles.length} critical circular dependencies:`);
      cycles.forEach((cycle, index) => {
        const readableCycle = cycle.map((p) => path.resolve(p)).join('\n     -> ');
        console.error(`  ${index + 1}) ${readableCycle}`);
      });
      console.error('');
    } else {
      console.log(`✅ [${absoluteEntry}] — Clean!`);
    }
  }

  if (globalHasCycles || criticalCycles.length > 0) {
    console.error('💥 Validation failed. Critical circular dependencies detected.');
    process.exit(1);
  } else {
    console.log('🎉 All packages checked. No critical circular dependencies found!');
    process.exit(0);
  }
}

main();

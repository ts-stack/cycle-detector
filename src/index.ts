#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type NodeState = 'VISITING' | 'VISITED';

// Performance caches that are safe to share across calls (read-only filesystem data)
const compilerOptionsCache = new Map<string, ts.CompilerOptions>();
const sourceFileCache = new Map<string, ts.SourceFile>();
const topLevelUsageCache = new Map<string, boolean>();
const exportedHoistedFunctionsCache = new Map<string, Set<string>>();
const resolvedSourceCache = new Map<string, string>(); // Performance cache for path mapping

function parseArgs() {
  return { entryPatterns: process.argv.slice(2) };
}

function isRuntimeImport(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (!node.moduleSpecifier) return false;
    return !node.isTypeOnly;
  }

  if (ts.isImportDeclaration(node)) {
    if (node.importClause?.phaseModifier) return false;
    if (!node.importClause) return true; // Side-effect import

    if (node.importClause.name) return true; // Default import present

    const namedBindings = node.importClause.namedBindings;
    if (namedBindings) {
      if (ts.isNamespaceImport(namedBindings)) return true;
      if (ts.isNamedImports(namedBindings)) {
        return !namedBindings.elements.every((el) => el.isTypeOnly);
      }
    }
    return true;
  }

  return false;
}

function getCompilerOptionsForFile(filePath: string): ts.CompilerOptions {
  const currentDir = path.dirname(filePath);
  const cachedOptions = compilerOptionsCache.get(currentDir);
  if (cachedOptions !== undefined) return cachedOptions;

  const configPath = ts.findConfigFile(currentDir, ts.sys.fileExists, 'tsconfig.json');

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

  const emptyOptions = {};
  compilerOptionsCache.set(currentDir, emptyOptions);
  return emptyOptions;
}

/**
 * Universal resolution engine: safely maps compiled assets (.js, .d.ts) back to source files (.ts)
 * Works flawlessly for standalone packages, polyrepos, and complex monorepos alike.
 */
function convertToSourcePath(resolvedPath: string): string {
  const isBuildDir = new RegExp(String.raw`[\\/](dist|build|lib|out|cjs|esm|bin)[\\/]`, 'i');

  if (/\.(ts|tsx|mts|cts)$/.test(resolvedPath) && !isBuildDir.test(resolvedPath)) {
    return resolvedPath;
  }

  const extensions = ['.ts', '.tsx', '.mts', '.cts'];

  let baseName = resolvedPath;
  if (baseName.endsWith('.d.ts')) baseName = baseName.slice(0, -5);
  else if (baseName.endsWith('.d.mts')) baseName = baseName.slice(0, -6);
  else if (baseName.endsWith('.d.cts')) baseName = baseName.slice(0, -6);
  else if (baseName.endsWith('.js')) baseName = baseName.slice(0, -3);
  else if (baseName.endsWith('.mjs')) baseName = baseName.slice(0, -4);
  else if (baseName.endsWith('.cjs')) baseName = baseName.slice(0, -4);
  else if (baseName.endsWith('.jsx')) baseName = baseName.slice(0, -4);

  for (const ext of extensions) {
    if (fs.existsSync(baseName + ext)) return baseName + ext;
  }

  const buildDirs = ['dist', 'build', 'lib', 'out', 'cjs', 'esm', 'bin'];
  const srcDirs = ['src', 'source', '.'];

  for (const bDir of buildDirs) {
    const regex = new RegExp(String.raw`([\\/])${bDir}([\\/])`, 'i');
    if (regex.test(baseName)) {
      for (const sDir of srcDirs) {
        if (bDir.toLowerCase() === sDir.toLowerCase()) continue;

        const replacedBase = baseName.replace(regex, `$1${sDir}$2`);
        for (const ext of extensions) {
          if (fs.existsSync(replacedBase + ext)) return replacedBase + ext;
        }
      }
    }
  }

  let currentDir = path.dirname(resolvedPath);
  while (currentDir && currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
      for (const sDir of ['src', 'source']) {
        const srcDirPath = path.join(currentDir, sDir);
        if (fs.existsSync(srcDirPath)) {
          const relativeToPackage = path.relative(currentDir, baseName);
          const pathParts = relativeToPackage.split(path.sep);

          if (pathParts.length > 1) {
            const subPath = pathParts.slice(1).join(path.sep);
            for (const ext of extensions) {
              const targetFile = path.join(srcDirPath, subPath + ext);
              if (fs.existsSync(targetFile)) return targetFile;
            }
          }
        }
      }
      break;
    }
    currentDir = path.dirname(currentDir);
  }

  return resolvedPath;
}

function resolveModule(moduleName: string, containingFile: string, options: ts.CompilerOptions): string | null {
  const result = ts.resolveModuleName(moduleName, containingFile, options, ts.sys);
  if (!result.resolvedModule) return null;

  const resolvedFileName = path.resolve(result.resolvedModule.resolvedFileName);

  let sourcePath = resolvedSourceCache.get(resolvedFileName);
  if (sourcePath === undefined) {
    sourcePath = convertToSourcePath(resolvedFileName);
    resolvedSourceCache.set(resolvedFileName, sourcePath);
  }

  if (sourcePath.includes(`${path.sep}node_modules${path.sep}`)) {
    return null;
  }

  return sourcePath;
}

function getCanonicalCycleKey(cycle: string[]): string {
  const nodes = cycle.slice(0, -1);
  if (nodes.length === 0) return '';

  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIdx]) minIdx = i;
  }

  const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
  rotated.push(rotated[0]);
  return rotated.join('|');
}

function parseFile(startPath: string, graph: Map<string, string[]>) {
  const queue = [startPath];

  while (queue.length > 0) {
    const filePath = queue.pop()!;

    if (graph.has(filePath) || !fs.existsSync(filePath)) continue;
    graph.set(filePath, []);

    const options = getCompilerOptionsForFile(filePath);

    let sourceFile = sourceFileCache.get(filePath);
    if (!sourceFile) {
      const content = fs.readFileSync(filePath, 'utf8');
      sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
      sourceFileCache.set(filePath, sourceFile);
    }

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

    for (const dep of imports) {
      if (!graph.has(dep)) queue.push(dep);
    }
  }
}

function getExportedHoistedFunctions(filePath: string): Set<string> {
  if (exportedHoistedFunctionsCache.has(filePath)) {
    return exportedHoistedFunctionsCache.get(filePath)!;
  }

  const hoisted = new Set<string>();
  if (!fs.existsSync(filePath)) {
    exportedHoistedFunctionsCache.set(filePath, hoisted);
    return hoisted;
  }

  let sourceFile = sourceFileCache.get(filePath);
  if (!sourceFile) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
      sourceFileCache.set(filePath, sourceFile);
    } catch {
      exportedHoistedFunctionsCache.set(filePath, hoisted);
      return hoisted;
    }
  }

  const localHoistedFuncs = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) {
        localHoistedFuncs.add(statement.name.text);
      }
      const hasExport = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const hasDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

      if (hasExport) {
        if (hasDefault) hoisted.add('default');
        else if (statement.name) hoisted.add(statement.name.text);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          const localName = el.propertyName ? el.propertyName.text : el.name.text;
          const exportedName = el.name.text;
          if (localHoistedFuncs.has(localName)) {
            hoisted.add(exportedName);
          }
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals && ts.isIdentifier(statement.expression)) {
        if (localHoistedFuncs.has(statement.expression.text)) {
          hoisted.add('default');
        }
      }
    }
  }

  exportedHoistedFunctionsCache.set(filePath, hoisted);
  return hoisted;
}

function collectBindingPattern(pattern: ts.BindingPattern, names: Set<string>) {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      names.add(element.name.text);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      collectBindingPattern(element.name, names);
    }
  }
}

function getLocalDeclarations(node: ts.Node): Set<string> {
  const names = new Set<string>();

  function collect(n: ts.Node) {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
      if (ts.isIdentifier(n.name)) {
        names.add(n.name.text);
      } else if (ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) {
        collectBindingPattern(n.name, names);
      }
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      names.add(n.name.text);
    } else if (ts.isClassDeclaration(n) && n.name) {
      names.add(n.name.text);
    }

    if (
      ts.isBlock(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n)
    ) {
      return;
    }
    ts.forEachChild(n, collect);
  }

  ts.forEachChild(node, collect);
  return names;
}

function hasTopLevelUsage(fromFile: string, toFile: string): boolean {
  if (!fs.existsSync(fromFile)) return false;

  const cacheKey = `${fromFile}-->${toFile}`;
  if (topLevelUsageCache.has(cacheKey)) return topLevelUsageCache.get(cacheKey)!;

  const options = getCompilerOptionsForFile(fromFile);

  let sourceFile = sourceFileCache.get(fromFile);
  if (!sourceFile) {
    try {
      const content = fs.readFileSync(fromFile, 'utf8');
      sourceFile = ts.createSourceFile(fromFile, content, ts.ScriptTarget.Latest, true);
      sourceFileCache.set(fromFile, sourceFile);
    } catch {
      topLevelUsageCache.set(cacheKey, false);
      return false;
    }
  }

  const hoistedExports = getExportedHoistedFunctions(toFile);
  const localToExportedName = new Map<string, string>();
  let namespaceImportName: string | null = null;
  let hasSideEffectOrReExport = false;

  function findImports(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (isRuntimeImport(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const resolved = resolveModule(specifier.text, fromFile, options);
          if (resolved === toFile) {
            if (ts.isImportDeclaration(node) && node.importClause) {
              const clause = node.importClause;
              if (clause.name) {
                localToExportedName.set(clause.name.text, 'default');
              }
              if (clause.namedBindings) {
                if (ts.isNamespaceImport(clause.namedBindings)) {
                  namespaceImportName = clause.namedBindings.name.text;
                } else if (ts.isNamedImports(clause.namedBindings)) {
                  for (const el of clause.namedBindings.elements) {
                    if (el.isTypeOnly) continue;
                    const exportedName = el.propertyName ? el.propertyName.text : el.name.text;
                    localToExportedName.set(el.name.text, exportedName);
                  }
                }
              }
            } else {
              hasSideEffectOrReExport = true;
            }
          }
        }
      }
    }
    ts.forEachChild(node, findImports);
  }

  findImports(sourceFile);

  if (hasSideEffectOrReExport) {
    topLevelUsageCache.set(cacheKey, true);
    return true;
  }
  if (localToExportedName.size === 0 && !namespaceImportName) {
    topLevelUsageCache.set(cacheKey, false);
    return false;
  }

  let dangerousTopLevelUsage = false;

  function checkNodeUsage(node: ts.Node, isInsideLazyScope: boolean, shadowedSymbols: Set<string>) {
    if (dangerousTopLevelUsage) return;

    let currentScopeLazy = isInsideLazyScope;
    let currentShadowed = shadowedSymbols;

    if (
      ts.isSourceFile(node) ||
      ts.isBlock(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const localDecls = getLocalDeclarations(node);
      if (localDecls.size > 0) {
        currentShadowed = new Set([...shadowedSymbols, ...localDecls]);
      }
    }

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
      const isStatic = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
      if (!isStatic) currentScopeLazy = true;
    }

    if (!currentScopeLazy && ts.isIdentifier(node)) {
      if (currentShadowed.has(node.text)) {
        return;
      }

      const isImportedSymbol = localToExportedName.has(node.text);
      const isNamespaceReference = namespaceImportName && node.text === namespaceImportName;

      if (isImportedSymbol || isNamespaceReference) {
        const parent = node.parent;

        const isImportOrExportDeclarationRef =
          ts.isImportSpecifier(parent) ||
          ts.isImportClause(parent) ||
          ts.isNamespaceImport(parent) ||
          ts.isExportSpecifier(parent);

        if (isImportOrExportDeclarationRef) return;
        if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
        if (ts.isPropertyAssignment(parent) && parent.name === node) return;
        if (
          (ts.isMethodDeclaration(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isInterfaceDeclaration(parent) ||
            ts.isFunctionDeclaration(parent)) &&
          parent.name === node
        ) {
          return;
        }

        if (isImportedSymbol) {
          const exportedName = localToExportedName.get(node.text)!;
          if (hoistedExports.has(exportedName)) return;
        }

        if (isNamespaceReference) {
          if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
            const propName = parent.name.text;
            if (hoistedExports.has(propName)) return;
          }
        }

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

    ts.forEachChild(node, (n) => checkNodeUsage(n, currentScopeLazy, currentShadowed));
  }

  checkNodeUsage(sourceFile, false, new Set<string>());
  topLevelUsageCache.set(cacheKey, dangerousTopLevelUsage);
  return dangerousTopLevelUsage;
}

function canReach(start: string, target: string, graph: Map<string, string[]>): boolean {
  const seen = new Set<string>();
  const stack = [start];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);

    const deps = graph.get(current) || [];
    for (const dep of deps) stack.push(dep);
  }
  return false;
}

function main() {
  const { entryPatterns } = parseArgs();

  if (entryPatterns.length === 0) {
    console.error('❌ Error: Please specify at least one entry point or glob pattern.');
    process.exit(1);
  }

  const graph = new Map<string, string[]>();
  const allUniqueCycles: string[][] = [];
  const globalDetectedCycles = new Set<string>();
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

  for (const entryPoint of entryPoints) {
    parseFile(entryPoint, graph);
  }

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
    if (!visited.has(entryPoint)) findCycles(entryPoint);
  }

  const criticalCycles: string[][] = [];

  for (const cycle of allUniqueCycles) {
    let isHarmfulCycle = false;
    for (let i = 0; i < cycle.length - 1; i++) {
      if (hasTopLevelUsage(cycle[i], cycle[i + 1])) {
        isHarmfulCycle = true;
        break;
      }
    }
    if (isHarmfulCycle) criticalCycles.push(cycle);
  }

  const entryPointCycles = new Map<string, string[][]>();
  for (const ep of entryPoints) entryPointCycles.set(ep, []);

  for (const cycle of criticalCycles) {
    const firstFile = cycle[0];
    const matchedEp = entryPoints.find((ep) => {
      const epDir = path.dirname(ep);
      return firstFile.startsWith(epDir + path.sep) || firstFile === ep;
    });

    if (matchedEp) {
      entryPointCycles.get(matchedEp)!.push(cycle);
    } else {
      const reachingEp = entryPoints.find((ep) => canReach(ep, firstFile, graph));
      if (reachingEp) entryPointCycles.get(reachingEp)!.push(cycle);
      else entryPointCycles.get(entryPoints[0])!.push(cycle);
    }
  }

  let globalHasCycles = false;

  for (const entryPoint of entryPoints) {
    const absoluteEntry = path.resolve(entryPoint);
    const cycles = entryPointCycles.get(entryPoint) || [];

    if (cycles.length > 0) {
      globalHasCycles = true;
      console.error(`❌ ${absoluteEntry} — Found ${cycles.length} critical circular dependencies:`);

      cycles.forEach((cycle, index) => {
        console.error(`  ${index + 1})`, '-'.repeat(80));
        for (let i = 0; i < cycle.length - 1; i++) {
          const currentFile = cycle[i];
          const nextFile = cycle[i + 1];
          const isTopLevel = hasTopLevelUsage(currentFile, nextFile);
          const prefix = isTopLevel ? '  💥 [Top-level] ' : '  ⏳ [Lazy]      ';
          console.error(`${prefix}${path.resolve(currentFile)}`);
        }
      });
      console.error('');
    } else {
      console.log(`✅ ${absoluteEntry}`);
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

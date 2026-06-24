#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

type NodeState = 'VISITING' | 'VISITED';

const graph = new Map<string, string[]>();
const visited = new Map<string, NodeState>();
const currentStack: string[] = [];
const detectedCycles: string[][] = [];

/**
 * Parses command line arguments to separate options from entry point patterns.
 */
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

/**
 * Checks if an import/export declaration is type-only.
 * Type-only imports are stripped during compilation and don't cause runtime cycles.
 */
function isRuntimeImport(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (!node.moduleSpecifier) return false;
    return !node.isTypeOnly;
  }

  if (ts.isImportDeclaration(node)) {
    if (!node.importClause) return true; // Side-effect import: import './foo'
    if (node.importClause.isTypeOnly) return false; // import type { X } from './foo'

    // Check individual specifiers: import { type A, B } from './foo'
    const namedBindings = node.importClause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      return !namedBindings.elements.every((el) => el.isTypeOnly);
    }
    return true;
  }

  return false;
}

/**
 * Resolves module paths using the TypeScript Compiler API.
 * Respects tsconfig paths/aliases and ESM extensions.
 */
function resolveModule(moduleName: string, containingFile: string, options: ts.CompilerOptions): string | null {
  const result = ts.resolveModuleName(moduleName, containingFile, options, ts.sys);
  if (result.resolvedModule && !result.resolvedModule.isExternalLibraryImport) {
    return result.resolvedModule.resolvedFileName;
  }
  return null;
}

/**
 * Analyzes a single entry point, builds its dependency graph, and detects cycles.
 */
function analyzeEntryPoint(entryPoint: string, projectPath?: string): string[][] {
  graph.clear();
  visited.clear();
  currentStack.length = 0;
  detectedCycles.length = 0;

  // Locate tsconfig.json automatically if not explicitly provided
  const configPath = projectPath
    ? path.resolve(projectPath)
    : ts.findConfigFile(path.dirname(entryPoint), ts.sys.fileExists, 'tsconfig.json');

  let compilerOptions: ts.CompilerOptions = {};

  if (configPath && fs.existsSync(configPath)) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
    compilerOptions = parsedConfig.options;
  }

  // Recursive AST parsing to build the graph
  function parseFile(filePath: string) {
    if (graph.has(filePath) || !fs.existsSync(filePath)) return;
    graph.set(filePath, []);

    const content = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];

    function walk(node: ts.Node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (isRuntimeImport(node)) {
          const specifier = node.moduleSpecifier;
          if (specifier && ts.isStringLiteral(specifier)) {
            const resolved = resolveModule(specifier.text, filePath, compilerOptions);
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

  // Graph coloring DFS algorithm for cycle detection
  function findCycles(node: string) {
    visited.set(node, 'VISITING');
    currentStack.push(node);

    for (const neighbor of graph.get(node) || []) {
      const state = visited.get(neighbor);
      if (state === 'VISITING') {
        const startIdx = currentStack.indexOf(neighbor);
        const cycle = currentStack.slice(startIdx);
        cycle.push(neighbor);
        detectedCycles.push(cycle);
      } else if (!state) {
        findCycles(neighbor);
      }
    }

    currentStack.pop();
    visited.set(node, 'VISITED');
  }

  parseFile(entryPoint);
  findCycles(entryPoint);

  return detectedCycles;
}

function main() {
  const { entryPatterns, projectPath } = parseArgs();

  if (entryPatterns.length == 0) {
    console.error('❌ Error: Please specify at least one entry point or glob pattern (e.g., packages/*/src/index.ts)');
    process.exit(1);
  }

  const entryPoints: string[] = [];

  // Expand glob patterns or fall back to direct paths
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

  console.log(`🔍 Found ${entryPoints.length} entry point(s) for analysis...\n`);

  let globalHasCycles = false;

  for (const entryPoint of entryPoints) {
    const relativeEntry = path.relative(process.cwd(), entryPoint);
    const cycles = analyzeEntryPoint(entryPoint, projectPath);

    if (cycles.length > 0) {
      globalHasCycles = true;
      console.error(`❌ [${relativeEntry}] — Found ${cycles.length} circular dependencies:`);
      cycles.forEach((cycle, index) => {
        const readableCycle = cycle.map((p) => path.relative(process.cwd(), p)).join(' -> ');
        console.error(`  ${index + 1}) ${readableCycle}`);
      });
      console.error('');
    } else {
      console.log(`✅ [${relativeEntry}] — Clean!`);
    }
  }

  if (globalHasCycles) {
    console.error('💥 Validation failed. Circular dependencies detected.');
    process.exit(1);
  } else {
    console.log('🎉 All packages checked. No circular dependencies found!');
    process.exit(0);
  }
}

main();

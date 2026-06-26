# Execution-Aware Circular Dependency Detector for TypeScript

`@ts-stack/cycle-detector` - this is a high-performance static analysis utility powered by the native TypeScript Compiler API. Unlike generic dependency visualizers, this tool evaluates the **runtime execution risk** of circular dependencies in monorepos and complex TypeScript applications, isolating architectural flaws from safe, deferred imports.

## Installation & Usage

You don't even need to install it! Just run it via `npx`:

```bash
npx @ts-stack/cycle-detector src/index.ts
# OR
npx @ts-stack/cycle-detector packages/*/src/index.ts
```

But you can install it locally:

```bash
npm install -D @ts-stack/cycle-detector
```

In your `package.json`:


```json
"scripts": {
  "lint:cycles": "cycle-detector packages/*/src/index.ts"
}
```

And then:

```bash
npm run lint:cycles
```

### Arguments & Flags

* `<entry-patterns>`: Glob patterns or paths to entry point files (e.g., `packages/*/src/index.ts`).
* `-p, --project <path>`: Path to your root or fallback `tsconfig.json`.

## Interpreting Diagnostics

When a breaking circular dependency is detected, the script identifies exactly **which file executes the token prematurely**, leaving non-blocking files clearly marked.

```txt
❌ [/packages/rest/src/index.ts] — Found 1 critical circular dependencies:
  1) --------------------------------------------------------------------------------
  ⏳ [Lazy]      /srv/git/ditsmod/ditsmod/packages/rest/src/extensions/routes.extension.ts
  ⏳ [Lazy]      /srv/git/ditsmod/ditsmod/packages/rest/src/decorators/rest-init-hooks-and-metadata.ts
  💥 [Top-level] /srv/git/ditsmod/ditsmod/packages/rest/src/init/rest.module.ts

💥 Validation failed. Critical circular dependencies detected.
```

### How to Refactor Based on the Log Above:

The log indicates that `/packages/rest/src/init/rest.module.ts` contains an immediate top-level expression (such as an active decorator evaluation or configuration factory instantiation) that forces the evaluation of `routes.extension.ts` before the module evaluation of `rest.module.ts` is complete. To fix this, extract the shared configuration metadata or decorator targets into a dedicated initialization file positioned lower in the dependency hierarchy.

## Exit Codes

* `0`: Success. Clean graph or only safe, runtime-deferred cyclic references found.
* `1`: Critical Top-level execution loops found. Build terminated.

## Why Use This Over Existing Solutions?

Popular tools like `madge` or generic ESLint rules (`eslint-plugin-import`) operate solely at the graph-theory level: if **File A** imports **File B** and **File B** imports **File A**, an error is flagged.

In large-scale TypeScript applications (especially those utilizing Dependency Injection, Decorators, or Monorepo structures like NestJS or Ditsmod), this naive approach leads to massive friction:

1. **False Positives:** JavaScript runtimes can perfectly handle circular references if the imported symbol is evaluated lazily (inside a function, class method, or non-static property). Standard tools cannot distinguish between a benign lazy cycle and a critical runtime failure.
2. **Monorepo Resolution Breakdown:** Tools often stumble when traversing internal monorepo dependencies, resolving to compiled `.d.ts` declarations or `dist/` artifacts instead of tracking back to the original `.ts` source code.

### Technical Differentiators

| Feature | @ts-stack/cycle-detector | Traditional Tools (e.g., Madge) | ESLint Rules |
| --- | --- | --- | --- |
| **Analysis Scope** | Execution-aware (Top-level vs. Lazy) | Pure Import Graph Topology | Token-based / File Boundary |
| **TypeScript Engine** | Native `typescript` Compiler API | Pre-bundled bundlers / Regex | AST Walkers (without Full Type Context) |
| **Monorepo Mapping** | Dynamic `package.json` -> `src` tracking | Requires complex path mapping config | Scoped only to single-package roots |
| **Signal-to-Noise Ratio** | High (Flags only breaking cycles) | Low (Floods with safe runtime loops) | High overhead / Slow parsing |

## Core Architecture & Technical Details

### 1. Execution-Scoped Risk Assessment

The analyzer parses the AST (Abstract Syntax Tree) to track not just *what* is imported, but *where* it is used:

* **Top-level Scope (`💥 [Top-level]`)**: The imported symbol is executed immediately during module evaluation (e.g., in a decorator declaration, global constant assignment, or class static property). This causes immediate runtime initialization crashes (`ReferenceError: Cannot access ... before initialization`).
* **Lazy Scope (`⏳ [Lazy]`)**: The symbol is referenced inside class methods, standard functions, constructor bodies, or non-static properties. Runtimes resolve these safely.

**`@ts-stack/cycle-detector` filters out 100% lazy loops and only fails the build if a cycle contains at least one critical Top-level trigger.**

### 2. Monorepo Source-to-Dist Tracking

In monorepos, internal package dependencies often resolve to `node_modules/<local-package>/dist/index.d.ts`. This utility hooks into `ts.resolveModuleName` and reads local `package.json` manifests dynamically. If an import points to an internal distribution directory, it computes the structural alignment and remaps the graph back into the actual uncompiled source file (`/src/.../.ts`), maintaining a clean, unbroken dependency graph across package boundaries.

### 3. Canonical Cycle Deduplication

To prevent log flooding from deeply nested structural loops, the DFS (Depth-First Search) cycle collector normalizes all found paths into a canonical key based on lexicographical rotation. You see each unique cycle exactly once, regardless of which file initiated the traversal.

## How It Works Under the Hood

```
[Entry Points] ──> [ts.resolveModuleName] ──> [AST Parsing] ──> [DFS Cycle Detection] ──> [Top-level Scope Validation] ──> [Targeted Diagnostic Report]
```

1. **Phase 1: Parse & Resolve:** Reads inputs, loads the closest `tsconfig.json` compiler options, and builds a strict runtime import graph.
2. **Phase 2: Graph Traversal:** Runs a non-recursive path collector detecting back-edges.
3. **Phase 3: Scope Validation:** For every edge in a detected cycle, it inspects whether the consumer node executes the imported token outside an execution-deferred scope block.
4. **Phase 4: Targeted Diagnostics:** Groups and outputs anomalies based on the entry point package context.

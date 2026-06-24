# @ts-stack/cycle-detector

A blistering fast, lightweight, zero-dependency CLI utility designed to detect circular dependencies in TypeScript (ESM) projects. 

Unlike other tools, it uses the native TypeScript Compiler API for smart path resolution (respecting your `tsconfig.json` paths/aliases) and **completely ignores type-only imports** (`import type`), as they don't cause actual runtime issues in Node.js.

## Features

- ⚡ **Blazing Fast**: Uses static AST parsing without full type-checking overhead.
- 🧠 **Smart Resolution**: Fully supports `tsconfig.json` `paths`, path mappings, and ESM extensions out of the box.
- 🧱 **Monorepo & Glob Support**: Can check multiple packages at once using wildcards.
- 🛑 **Type-Safe**: Intelligently skips `import type` and type-only named bindings.
- 🤖 **CI/CD Ready**: Returns non-zero exit codes when cycles are found.

Note: required Node.js >= v22.0.0.

## Installation

You don't even need to install it! Just run it via `npx`:

```bash
npx @ts-stack/cycle-detector src/index.ts
# OR
npx @ts-stack/cycle-detector packages/*/src/index.ts
```

Also you can install this utility locally:

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

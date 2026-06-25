/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── Circular dependencies ─────────────────────────────────────────────────
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies cause subtle import-order bugs and are hard to refactor.',
      from: {},
      to: { circular: true },
    },

    // ── Layer isolation ───────────────────────────────────────────────────────
    // These rules forbid *runtime* coupling across layers. With
    // `tsPreCompilationDeps: true` (below) dependency-cruiser also sees
    // `import type` edges; those compile away to nothing and are NOT a layering
    // violation, so each runtime rule excludes `type-only` dependencies via
    // `dependencyTypesNot`. A type-only import of a type that happens to live in
    // a store/component file is allowed; a value import is not.
    {
      name: 'components-not-from-stores',
      severity: 'info',
      comment:
        'INFO (not warn) by convention: this codebase reads state via direct ' +
        'useXStore(selector) access in components — there is no read-bridge hook ' +
        'layer, so these edges are the accepted pattern and only documented here. ' +
        'Test files are excluded entirely: they legitimately seed stores via ' +
        'setState/getState to build fixtures. Kept as a marker so a future decision ' +
        'to introduce bridge hooks can re-promote this to warn/error.',
      from: { path: '^src/components/', pathNot: '\\.(test|smoke\\.test)\\.tsx?$' },
      to: { path: '^src/stores/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'services-not-from-components',
      severity: 'error',
      comment: 'Services are a data-access layer — they must not depend on UI components.',
      from: { path: '^src/services/' },
      to: { path: '^src/components/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'services-not-from-stores',
      severity: 'error',
      comment:
        'Services must not depend on Zustand stores — stores depend on services, not vice versa. ' +
        'Exception: *Actions.ts files are intentional thin orchestrators that call store.getState() ' +
        'as a facade over the store\'s own mutation methods + history recording.',
      from: {
        path: '^src/services/',
        pathNot: '(Actions|Runner)(\\.test)?\\.ts$',
      },
      to: { path: '^src/stores/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'stores-not-from-components',
      severity: 'error',
      comment: 'Zustand stores are domain state — they must not import UI components.',
      from: { path: '^src/stores/' },
      to: { path: '^src/components/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'utils-not-from-ui',
      severity: 'error',
      comment: 'Pure utilities must not depend on components, stores, hooks, or services.',
      from: { path: '^src/utils/' },
      to: {
        path: '^src/(components|stores|hooks|services)/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'types-not-from-ui',
      severity: 'error',
      comment: 'Shared type definitions must have zero runtime dependencies on UI or state layers.',
      from: { path: '^src/types/' },
      to: {
        path: '^src/(components|stores|hooks|services)/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'hooks-not-from-components',
      severity: 'error',
      comment: 'Hooks must not import components — that creates a tight coupling that prevents reuse.',
      from: { path: '^src/hooks/' },
      to: { path: '^src/components/', dependencyTypesNot: ['type-only'] },
    },

    // ── Tauri IPC boundary ────────────────────────────────────────────────────
    {
      name: 'no-direct-tauri-invoke',
      severity: 'error',
      comment:
        'Never call @tauri-apps/api/core invoke() directly from components, stores, or hooks. ' +
        'All IPC must go through typed wrappers in src/services/.',
      from: { path: '^src/(components|stores|hooks)/' },
      to: { path: '@tauri-apps/api/core' },
    },

    // ── Orphaned modules ──────────────────────────────────────────────────────
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Files not imported by anything are likely dead code.',
      from: { orphan: true, pathNot: '^src/(main\\.tsx|App\\.tsx|vite-env\\.d\\.ts|types/capture\\.ts|types/commandForm\\.ts|styles/|locales/|test/|i18n/)' },
      to: {},
    },
  ],

  options: {
    // Track `import type` edges so type-only consumers count as real
    // dependents — otherwise type modules used solely via `import type`
    // (e.g. types/sshHost.ts) are mis-flagged as orphans.
    tsPreCompilationDeps: true,
    doNotFollow: {
      path: 'node_modules',
    },
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: '^(node_modules|src/(components|stores|hooks|services|utils|types))/[^/]+',
        theme: {
          graph: { bgcolor: '#1e293b', color: '#94a3b8', fontcolor: '#f8fafc' },
          node: { color: '#334155', fillcolor: '#1e293b', fontcolor: '#e2e8f0', shape: 'box', style: 'filled,rounded' },
          edge: { color: '#475569' },
        },
      },
      text: {
        highlightFocused: true,
      },
    },
  },
};

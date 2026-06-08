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
    {
      name: 'components-not-from-stores',
      severity: 'warn',
      comment:
        'Components should read state through hooks, not import stores directly. ' +
        'Wrap store access in a custom hook under src/hooks/ instead.',
      from: { path: '^src/components/' },
      to: { path: '^src/stores/' },
    },
    {
      name: 'services-not-from-components',
      severity: 'error',
      comment: 'Services are a data-access layer — they must not depend on UI components.',
      from: { path: '^src/services/' },
      to: { path: '^src/components/' },
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
      to: { path: '^src/stores/' },
    },
    {
      name: 'stores-not-from-components',
      severity: 'error',
      comment: 'Zustand stores are domain state — they must not import UI components.',
      from: { path: '^src/stores/' },
      to: { path: '^src/components/' },
    },
    {
      name: 'utils-not-from-ui',
      severity: 'error',
      comment: 'Pure utilities must not depend on components, stores, hooks, or services.',
      from: { path: '^src/utils/' },
      to: { path: '^src/(components|stores|hooks|services)/' },
    },
    {
      name: 'types-not-from-ui',
      severity: 'error',
      comment: 'Shared type definitions must have zero runtime dependencies on UI or state layers.',
      from: { path: '^src/types/' },
      to: { path: '^src/(components|stores|hooks|services)/' },
    },
    {
      name: 'hooks-not-from-components',
      severity: 'error',
      comment: 'Hooks must not import components — that creates a tight coupling that prevents reuse.',
      from: { path: '^src/hooks/' },
      to: { path: '^src/components/' },
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

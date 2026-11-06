// Workspace identity is deliberately limited to navigation and interactive accents.
// Shared surfaces, status colours and chart series keep the application palette.
export const WORKSPACE_PALETTES = {
  codex: {
    light: {
      accent: '#29644d',
      solid: '#2a674d',
      hover: '#20533f',
      tint: '#eff4e9',
      'tint-ink': '#527656',
      'tint-border': '#9cb79e',
      focus: '#72a589',
      sidebar: '#1c3c32',
      'sidebar-ink': '#c4d3c9',
      'sidebar-muted': '#9db8a7',
      'sidebar-faint': '#8ba899',
      'sidebar-strong': '#f2f7f1',
      'sidebar-hover': '#274a3c',
      'sidebar-active': '#315445',
      'sidebar-line': '#2b5143',
      'sidebar-control': '#24483c',
      'sidebar-control-hover': '#2a5345',
      'sidebar-control-line': '#31594a',
      'sidebar-menu-line': '#3a6051',
      mark: '#d1e8a9',
      'mark-ink': '#254d37',
    },
    dark: {
      accent: '#5fc79b',
      solid: '#2a674d',
      hover: '#337c5e',
      tint: '#26352d',
      'tint-ink': '#a1c6a5',
      'tint-border': '#527b62',
      focus: '#7cb99a',
    },
  },
  claude: {
    light: {
      accent: '#95513b',
      solid: '#9b563f',
      hover: '#80442f',
      tint: '#f6eee8',
      'tint-ink': '#925e48',
      'tint-border': '#c6a18c',
      focus: '#b78065',
      sidebar: '#3e302b',
      'sidebar-ink': '#d9cec7',
      'sidebar-muted': '#c3ada0',
      'sidebar-faint': '#b49c8f',
      'sidebar-strong': '#faf3ee',
      'sidebar-hover': '#4c3b33',
      'sidebar-active': '#60483c',
      'sidebar-line': '#574238',
      'sidebar-control': '#49382f',
      'sidebar-control-hover': '#584236',
      'sidebar-control-line': '#685043',
      'sidebar-menu-line': '#745a4b',
      mark: '#e6b98e',
      'mark-ink': '#513728',
    },
    dark: {
      accent: '#dfa98b',
      solid: '#995840',
      hover: '#a86249',
      tint: '#382c27',
      'tint-ink': '#dfb499',
      'tint-border': '#87634f',
      focus: '#ce9a7b',
      sidebar: '#302723',
      'sidebar-hover': '#41332c',
      'sidebar-active': '#554035',
      'sidebar-control': '#3c2f29',
      'sidebar-control-hover': '#4b392f',
    },
  },
  opencode: {
    light: {
      accent: '#50545b',
      solid: '#50545b',
      hover: '#3e4248',
      tint: '#eef0f2',
      'tint-ink': '#626870',
      'tint-border': '#a7adb5',
      focus: '#8a929d',
      sidebar: '#2c2e32',
      'sidebar-ink': '#d1d3d7',
      'sidebar-muted': '#b1b5bd',
      'sidebar-faint': '#9da3ad',
      'sidebar-strong': '#f3f4f5',
      'sidebar-hover': '#383b40',
      'sidebar-active': '#464a51',
      'sidebar-line': '#42464d',
      'sidebar-control': '#35383d',
      'sidebar-control-hover': '#41454c',
      'sidebar-control-line': '#50555e',
      'sidebar-menu-line': '#5c626c',
      mark: '#d4d7dc',
      'mark-ink': '#34373d',
    },
    dark: {
      accent: '#c3c8d0',
      solid: '#535962',
      hover: '#646c77',
      tint: '#2c3036',
      'tint-ink': '#c2c8d1',
      'tint-border': '#707985',
      focus: '#a1aab7',
      sidebar: '#222428',
      'sidebar-hover': '#303339',
      'sidebar-active': '#3f444c',
      'sidebar-control': '#2c2f34',
      'sidebar-control-hover': '#393e45',
    },
  },
};

// Additional model-only tools keep the same readable navigation structure,
// while having their own identity in both the selector and selected workspace.
const additionalPalettes = {
  dsh: {
    accent: '#2457a1', solid: '#285da8', hover: '#204a88', tint: '#eaf1fb',
    'tint-ink': '#3e618e', 'tint-border': '#8daacb', focus: '#7099ca',
    sidebar: '#263c59', 'sidebar-hover': '#304966', 'sidebar-active': '#385775',
    'sidebar-control': '#2d4663', 'sidebar-control-hover': '#395573', mark: '#8cbcff',
    darkAccent: '#91bdf6', darkTint: '#26354b', darkTintInk: '#b8d1f2',
  },
  workbuddy: {
    accent: '#316a4b', solid: '#326f4e', hover: '#28583e', tint: '#eaf5ed',
    'tint-ink': '#416c50', 'tint-border': '#93bea0', focus: '#72aa83',
    sidebar: '#29483b', 'sidebar-hover': '#345749', 'sidebar-active': '#3d6553',
    'sidebar-control': '#315343', 'sidebar-control-hover': '#3d6551', mark: '#a6e6b6',
    darkAccent: '#91d8aa', darkTint: '#263a2e', darkTintInk: '#b5dcc1',
  },
  pi: {
    accent: '#6c4a92', solid: '#70509a', hover: '#593e7d', tint: '#f1edf8',
    'tint-ink': '#6e5789', 'tint-border': '#af9bc8', focus: '#a489c0',
    sidebar: '#3b304c', 'sidebar-hover': '#493b5c', 'sidebar-active': '#59476d',
    'sidebar-control': '#453856', 'sidebar-control-hover': '#554466', mark: '#cfb3f3',
    darkAccent: '#c5a9e8', darkTint: '#352c40', darkTintInk: '#d3c0e9',
  },
  minimax: {
    accent: '#a03d48', solid: '#a3434d', hover: '#83323c', tint: '#faeeee',
    'tint-ink': '#93545b', 'tint-border': '#ca9b9e', focus: '#bf858a',
    sidebar: '#4b3035', 'sidebar-hover': '#5b3a40', 'sidebar-active': '#6b454b',
    'sidebar-control': '#57383d', 'sidebar-control-hover': '#684349', mark: '#ffadb1',
    darkAccent: '#f0a3a8', darkTint: '#402c30', darkTintInk: '#e8b9bc',
  },
};
for (const [name, p] of Object.entries(additionalPalettes)) {
  WORKSPACE_PALETTES[name] = {
    light: {
      ...WORKSPACE_PALETTES.opencode.light,
      accent: p.accent, solid: p.solid, hover: p.hover, tint: p.tint,
      'tint-ink': p['tint-ink'], 'tint-border': p['tint-border'], focus: p.focus,
      sidebar: p.sidebar, 'sidebar-hover': p['sidebar-hover'], 'sidebar-active': p['sidebar-active'],
      'sidebar-control': p['sidebar-control'], 'sidebar-control-hover': p['sidebar-control-hover'],
      'sidebar-ink': '#e5e9ee', 'sidebar-muted': '#d4dbe3', 'sidebar-faint': '#c2cbd5',
      mark: p.mark, 'mark-ink': '#20252b',
    },
    dark: {
      accent: p.darkAccent, solid: p.solid, hover: p.hover, tint: p.darkTint,
      'tint-ink': p.darkTintInk, 'tint-border': p['tint-border'], focus: p.focus,
    },
  };
}

export function workspaceVariables(workspace, appearance) {
  const palette = WORKSPACE_PALETTES[workspace];
  return appearance === 'dark' ? { ...palette.light, ...palette.dark } : palette.light;
}

/** Selectors mirror the base theme: explicit light always wins over the system. */
export function renderWorkspaceTheme() {
  const declarations = (workspace, appearance, indent = '  ') =>
    Object.entries(workspaceVariables(workspace, appearance)).map(
      ([name, value]) => `${indent}--workspace-${name}: ${value};`,
    );
  const lines = [
    '',
    '/* Subtle software-specific accents; shared surfaces stay neutral. */',
    ':root {',
    ...Object.entries(WORKSPACE_PALETTES).map(
      ([workspace, palette]) => `  --agent-${workspace}: ${palette.light.mark};`,
    ),
    '}',
    '',
  ];
  for (const workspace of Object.keys(WORKSPACE_PALETTES)) {
    const selector = `:root[data-workspace="${workspace}"]`;
    lines.push(
      workspace === 'codex' ? `:root,\n${selector} {` : `${selector} {`,
      ...declarations(workspace, 'light'),
      '}',
      '',
      '@media (prefers-color-scheme: dark) {',
      workspace === 'codex'
        ? `  :root:not([data-theme="light"]):not([data-workspace]),\n  ${selector}:not([data-theme="light"]) {`
        : `  ${selector}:not([data-theme="light"]) {`,
      ...declarations(workspace, 'dark', '    '),
      '  }',
      '}',
      '',
      workspace === 'codex'
        ? `:root[data-theme="dark"]:not([data-workspace]),\n${selector}[data-theme="dark"] {`
        : `${selector}[data-theme="dark"] {`,
      ...declarations(workspace, 'dark'),
      '}',
      '',
    );
  }
  return lines.join('\n');
}

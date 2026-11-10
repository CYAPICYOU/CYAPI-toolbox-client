// App identity comes from the bundled logo artwork. Shared surfaces, status
// colours and chart series keep the application palette.
// SVG colours are sampled from their fills/gradient stops; PNG colours from
// opaque foreground pixels. Monochrome logos intentionally stay neutral.
export const LOGO_COLOURS = {
  codex: '#3941ff', // codex-color.svg: blue-violet gradient
  claude: '#d97757',
  opencode: '#383838',
  dsh: '#4d6bfe',
  workbuddy: '#01c886',
  pi: '#f09082', // coral, one of the two largest areas in Pi's three-colour mark
  minimax: '#e2167e',
  cline: '#383838',
  kilo: '#383838',
  qwen: '#082dff',
  kimi: '#1783ff',
  continue: '#303038', // dominant non-white pixels in the official extension icon
  aider: '#00f8a0', // dominant bright foreground in the official website icon
  cursor: '#383838',
  gemini: '#3186ff', // base fill underneath the multicolour gradient
  grok: '#383838',
};

const rgb = (hex) =>
  hex
    .slice(1)
    .match(/../g)
    .map((part) => parseInt(part, 16));
const hex = (channels) =>
  '#' + channels.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mix = (a, b, amount) => hex(rgb(a).map((v, i) => v * (1 - amount) + rgb(b)[i] * amount));

function hueAndSaturation(colour) {
  const [r, g, b] = rgb(colour).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (!delta) return [0, 0];
  const hue =
    max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue / 6, delta / (1 - Math.abs(max + min - 1))];
}

function tone(hue, saturation, lightness) {
  const channel = (n) => {
    const k = (n + hue * 12) % 12;
    const a = saturation * Math.min(lightness, 1 - lightness);
    return 255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return hex([channel(0), channel(8), channel(4)]);
}

function contrast(a, b) {
  const luminance = (colour) => {
    const c = rgb(colour)
      .map((v) => v / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

// Keep the original hue, changing only how far it is mixed toward black/white
// until small labels and white button text have enough contrast.
function readable(colour, backgrounds, towards) {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(colour, towards, step / 100);
    if (backgrounds.every((background) => contrast(candidate, background) >= 4.7)) return candidate;
  }
  return towards;
}

function logoPalette(seed) {
  const [hue, saturation] = hueAndSaturation(seed);
  const colour = (s, l) => tone(hue, saturation * s, l);
  const lightTint = colour(0.28, 0.96);
  const darkTint = colour(0.23, 0.16);
  const accent = readable(seed, ['#ffffff', lightTint], '#000000');
  const darkAccent = readable(seed, ['#1e2226', darkTint], '#ffffff');
  const solid = readable(seed, ['#ffffff'], '#000000');
  const navigation = (dark) => ({
    sidebar: colour(0.25, dark ? 0.105 : 0.16),
    'sidebar-ink': colour(0.13, 0.85),
    'sidebar-muted': colour(0.16, 0.76),
    'sidebar-faint': colour(0.13, 0.67),
    'sidebar-strong': colour(0.12, 0.97),
    'sidebar-hover': colour(0.25, dark ? 0.16 : 0.21),
    'sidebar-active': colour(0.31, dark ? 0.23 : 0.28),
    'sidebar-line': colour(0.21, dark ? 0.22 : 0.28),
    'sidebar-control': colour(0.25, dark ? 0.145 : 0.19),
    'sidebar-control-hover': colour(0.28, dark ? 0.2 : 0.25),
    'sidebar-control-line': colour(0.21, dark ? 0.27 : 0.33),
    'sidebar-menu-line': colour(0.21, dark ? 0.31 : 0.37),
    mark: colour(0.72, 0.8),
    'mark-ink': colour(0.35, 0.18),
  });
  return {
    light: {
      accent,
      solid,
      hover: mix(solid, '#000000', 0.15),
      tint: lightTint,
      'tint-ink': accent,
      'tint-border': colour(0.32, 0.7),
      focus: accent,
      ...navigation(false),
    },
    dark: {
      accent: darkAccent,
      solid,
      hover: mix(solid, '#000000', 0.15),
      tint: darkTint,
      'tint-ink': darkAccent,
      'tint-border': colour(0.3, 0.42),
      focus: darkAccent,
      ...navigation(true),
    },
  };
}

// The workflow workbench has no selected App and retains the Toolbox identity.
export const WORKSPACE_PALETTES = {
  toolbox: {
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
      'sidebar-muted': '#a8c1b1',
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
  ...Object.fromEntries(Object.entries(LOGO_COLOURS).map(([id, seed]) => [id, logoPalette(seed)])),
};

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
    '/* App accents derived from the bundled logo colours. */',
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
      workspace === 'toolbox' ? `:root,\n${selector} {` : `${selector} {`,
      ...declarations(workspace, 'light'),
      '}',
      '',
      '@media (prefers-color-scheme: dark) {',
      workspace === 'toolbox'
        ? `  :root:not([data-theme="light"]):not([data-workspace]),\n  ${selector}:not([data-theme="light"]) {`
        : `  ${selector}:not([data-theme="light"]) {`,
      ...declarations(workspace, 'dark', '    '),
      '  }',
      '}',
      '',
      workspace === 'toolbox'
        ? `:root[data-theme="dark"]:not([data-workspace]),\n${selector}[data-theme="dark"] {`
        : `${selector}[data-theme="dark"] {`,
      ...declarations(workspace, 'dark'),
      '}',
      '',
    );
  }
  return lines.join('\n');
}

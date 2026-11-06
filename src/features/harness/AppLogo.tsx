import type { CSSProperties } from 'react';
import codex from '../../assets/app-logos/lobe/codex-color.svg';
import claude from '../../assets/app-logos/lobe/claude-color.svg';
import opencode from '../../assets/app-logos/lobe/opencode.svg';
import deepseek from '../../assets/app-logos/lobe/deepseek-color.svg';
import workbuddy from '../../assets/app-logos/lobe/workbuddy-color.svg';
import minimax from '../../assets/app-logos/lobe/minimax-color.svg';
import cline from '../../assets/app-logos/lobe/cline.svg';
import kilo from '../../assets/app-logos/lobe/kilocode.svg';
import qwen from '../../assets/app-logos/lobe/qwen-color.svg';
import kimi from '../../assets/app-logos/lobe/kimi-color.svg';
import roo from '../../assets/app-logos/lobe/roocode.svg';
import cursor from '../../assets/app-logos/lobe/cursor.svg';
import gemini from '../../assets/app-logos/lobe/gemini-color.svg';
import grok from '../../assets/app-logos/lobe/grok.svg';
import pi from '../../assets/app-logos/pi/logo.svg';
import continueLogo from '../../assets/app-logos/continue/logo.png';
import aider from '../../assets/app-logos/aider/logo.png';

// LobeHub brand marks: https://github.com/lobehub/lobe-icons (MIT).
// Pi: https://pi.dev/logo-auto.svg; Continue / Aider: their official extension / website icons.
// Upstream licenses are retained beside the bundled assets.
const logos: Record<string, { src: string; mono?: boolean }> = {
  codex: { src: codex },
  claude: { src: claude },
  opencode: { src: opencode, mono: true },
  dsh: { src: deepseek },
  workbuddy: { src: workbuddy },
  pi: { src: pi },
  minimax: { src: minimax },
  cline: { src: cline, mono: true },
  kilo: { src: kilo, mono: true },
  qwen: { src: qwen },
  kimi: { src: kimi, mono: true },
  continue: { src: continueLogo },
  roo: { src: roo, mono: true },
  aider: { src: aider },
  cursor: { src: cursor, mono: true },
  gemini: { src: gemini },
  grok: { src: grok, mono: true },
};

export function AppLogo({ id, size = 'small' }: { id: string; size?: 'small' | 'large' }) {
  const logo = logos[id];
  if (!logo) return null;
  return (
    <span className={`n-app-logo n-app-logo-${size}`} aria-hidden="true">
      {logo.mono ? (
        <span
          className="n-app-logo-mono"
          style={{ '--app-logo-url': `url("${logo.src}")` } as CSSProperties}
        />
      ) : (
        <img src={logo.src} alt="" draggable={false} />
      )}
    </span>
  );
}

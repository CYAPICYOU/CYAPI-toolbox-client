import lobe from '../../assets/app-logos/lobe/LICENSE?raw';
import continueLicense from '../../assets/app-logos/continue/LICENSE?raw';
import aider from '../../assets/app-logos/aider/LICENSE?raw';
import pi from '../../assets/app-logos/pi/LICENSE?raw';

export const appLogoNotices = [
  ['LobeHub Icons — https://github.com/lobehub/lobe-icons', lobe],
  ['Continue logo — https://github.com/continuedev/continue', continueLicense],
  ['Aider logo — https://github.com/Aider-AI/aider', aider],
  ['Pi logo — https://pi.dev', pi],
]
  .map(([name, license]) => `${name}\n\n${license}`)
  .join('\n\n');

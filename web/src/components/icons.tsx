// Icons beside lucide's: VSCodium's logo for VS Code (assets/vscodium, MIT),
// drawn in the color of the text like the other icons.

import codium from '../assets/vscodium/codium.svg?raw';

const codiumPath = /\sd="([^"]+)"/.exec(codium)?.[1] ?? '';

/** VS Code: VSCodium's logo, sized and colored like a lucide icon. */
export function CodeIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`lucide code-icon ${className}`} viewBox="0 0 100 100" aria-hidden="true">
      <path fill="currentColor" d={codiumPath} />
    </svg>
  );
}

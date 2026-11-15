// Icons beside lucide's.

import { SquareCode } from 'lucide-react';

/** VS Code: a code mark, sized and colored like a lucide icon. */
export function CodeIcon({ className = '' }: { className?: string }) {
  return <SquareCode className={`code-icon ${className}`} aria-hidden="true" />;
}

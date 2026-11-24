// The repository's root, for tests and tools that read its other files
// (spec/vectors, the Go program while it exists). Not used by the product.
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Why a machine build cannot be deployed to a machine: the code the
// machine's state carries (State.failure), which the web UI explains
// (machine.failure.<code>), and the message, what ssh, the probe or the
// download said.

/** The codes of deployment failures. */
export const DeployCode = {
  /** No machine build for the machine's platform. */
  PlatformUnsupported: 'platform_unsupported',
  /** An x86-64 processor without SSE4.2, which Bun's executables need. */
  CPUUnsupported: 'cpu_unsupported',
  /** musl without libstdc++ and libgcc, which Bun's musl executables need. */
  LibsMissing: 'libs_missing',
  /** The machine could not get its build: it could not download it, and
   * the core has it neither in its directory, its cache nor its own
   * executable, and cannot download it either. */
  BuildUnavailable: 'build_unavailable',
} as const;
export type DeployCode = (typeof DeployCode)[keyof typeof DeployCode];

const CODES = new Set<string>(Object.values(DeployCode));

/** A deployment failure with its code (the message starts with it). */
export class Unsupported extends Error {
  readonly code: DeployCode;
  constructor(code: DeployCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** The deployment code an error carries, undefined for another error. */
export function deployCode(e: unknown): DeployCode | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CODES.has(code) ? (code as DeployCode) : undefined;
}

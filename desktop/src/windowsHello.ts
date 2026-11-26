// Windows Hello through PowerShell and Windows.Security.Credentials: the
// UserConsentVerifier for the proofs of presence, and KeyCredentialManager
// for the variable vault's unlock key (an RSA key of the user's Hello
// container, whose PKCS#1 v1.5 signature of a challenge the hub keeps is
// the same each time). The app starts powershell.exe from the system
// directory (powershellPath), with no profile and no questions, and gives it
// a script on stdin; the values (a prompt's message, a key's name, a
// challenge) travel in environment variables, never in the script. The
// script awaits the WinRT operation through AsTask and prints the result,
// which is compared with what means yes: "Available" for the check,
// "Verified" for a request, "True" for key support, "Success" and the bytes
// for a key operation. Anything else (the user cancelling, a wrong PIN, a
// machine without Hello, a PowerShell that is restricted or fails, a
// timeout) counts as no.

import { win32 } from 'node:path';

/** powershell.exe by its full path under the system directory, so that no
 * program a PATH entry or the working directory could name stands in for
 * it. */
export function powershellPath(systemRoot: string | undefined): string {
  return win32.join(systemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The arguments of powershell.exe: no profile, no questions, the script on
 * stdin. */
export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];

/** How long a run may take before the caller gives up on it. */
export const HELLO_TIMEOUT_MS = 2 * 60_000;

/** The environment variable that carries the prompt's message, so that
 * the text is never part of the script. */
export const MESSAGE_VAR = 'USER_VERIFY_MESSAGE';

/** Runs a PowerShell script (stdin) with env added to the environment; the
 * stdout. Rejects on a timeout (HELLO_TIMEOUT_MS) or a non-zero exit. */
export type RunPowerShell = (script: string, env: Record<string, string>) => Promise<string>;

// Loads the WinRT types, awaits a WinRT operation through
// System.WindowsRuntimeSystemExtensions' AsTask, and ends non-zero on any
// error.
const prelude = (types: string) => `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
${types}  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  } | Select-Object -First 1
  function Wait-Operation($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
  }
`;
const PRELUDE = prelude(
  `  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]\n`,
);
const KEYS_PRELUDE = prelude(
  `  $null = [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $null = [Windows.Security.Cryptography.Core.CryptographicPublicKeyBlobType, Windows.Security.Cryptography.Core, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IBuffer, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $buffers = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]
`,
);
const END = `
} catch {
  exit 1
}
`;

const AVAILABLE_SCRIPT =
  PRELUDE +
  `  Write-Output (Wait-Operation ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]))` +
  END;

const REQUEST_SCRIPT =
  PRELUDE +
  `  Write-Output (Wait-Operation ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($env:${MESSAGE_VAR})) ([Windows.Security.Credentials.UI.UserConsentVerificationResult]))` +
  END;

/** Windows Hello through run. Every failure is false. */
export function helloFor(run: RunPowerShell) {
  const ask = async (script: string, env: Record<string, string>, want: string) => {
    try {
      return (await run(script, env)).trim() === want;
    } catch {
      return false;
    }
  };
  return {
    available: () => ask(AVAILABLE_SCRIPT, {}, 'Available'),
    request: (message: string) => ask(REQUEST_SCRIPT, { [MESSAGE_VAR]: message }, 'Verified'),
  };
}

/** The environment variables of the key operations: the key's name and
 * the challenge to sign (base64). */
export const KEY_NAME_VAR = 'HELLO_KEY_NAME';
export const CHALLENGE_VAR = 'HELLO_CHALLENGE';

const MANAGER = '[Windows.Security.Credentials.KeyCredentialManager]';
const STATUS_SUCCESS = '[Windows.Security.Credentials.KeyCredentialStatus]::Success';
// A KeyCredentialRetrievalResult or KeyCredentialOperationResult that is not
// a success prints its status and ends.
const unlessSuccess = (r: string) => `  if (${r}.Status -ne ${STATUS_SUCCESS}) { Write-Output ([string]${r}.Status); exit 0 }\n`;

const KEYS_SUPPORTED_SCRIPT = KEYS_PRELUDE + `  Write-Output (Wait-Operation (${MANAGER}::IsSupportedAsync()) ([bool]))` + END;

// Makes the key (replacing one of the same name) and prints its public key
// as SubjectPublicKeyInfo (DER).
const KEY_CREATE_SCRIPT =
  KEYS_PRELUDE +
  `  $r = Wait-Operation (${MANAGER}::RequestCreateAsync($env:${KEY_NAME_VAR}, [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
` +
  unlessSuccess('$r') +
  `  $key = $r.Credential.RetrievePublicKey([Windows.Security.Cryptography.Core.CryptographicPublicKeyBlobType]::X509SubjectPublicKeyInfo)
  Write-Output ('Success ' + [Convert]::ToBase64String($buffers::ToArray($key)))` +
  END;

// Opens the key and prints its signature of the challenge.
const KEY_SIGN_SCRIPT =
  KEYS_PRELUDE +
  `  $r = Wait-Operation (${MANAGER}::OpenAsync($env:${KEY_NAME_VAR})) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
` +
  unlessSuccess('$r') +
  `  $challenge = $buffers::AsBuffer([byte[]][Convert]::FromBase64String($env:${CHALLENGE_VAR}))
  $s = Wait-Operation ($r.Credential.RequestSignAsync($challenge)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
` +
  unlessSuccess('$s') +
  `  Write-Output ('Success ' + [Convert]::ToBase64String($buffers::ToArray($s.Result)))` +
  END;

/** Why a key operation gave nothing: the user cancelled, the key is gone
 * (KeyCredentialStatus NotFound), anything else. */
export type KeyError = 'cancel' | 'invalidated' | 'failed';
export type KeyResult = { ok: true; value: Buffer } | { ok: false; error: KeyError };

/** A Hello key's name as the shell makes it, and the most its public key
 * and a signature may be. */
const KEY_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_KEY_BYTES = 2048;

/** The result of a key operation's output: "Success <base64>" or a
 * KeyCredentialStatus. */
export function keyResult(out: string): KeyResult {
  const line = out.trim();
  const m = /^Success ([A-Za-z0-9+/]+={0,2})$/.exec(line);
  if (m) {
    const value = Buffer.from(m[1], 'base64');
    return value.length > 0 && value.length <= MAX_KEY_BYTES && value.toString('base64') === m[1]
      ? { ok: true, value }
      : { ok: false, error: 'failed' };
  }
  if (line === 'NotFound') return { ok: false, error: 'invalidated' };
  if (line === 'UserCanceled') return { ok: false, error: 'cancel' };
  return { ok: false, error: 'failed' };
}

export interface HelloKeys {
  /** Whether Hello keys can be made here (KeyCredentialManager.IsSupportedAsync). */
  supported(): Promise<boolean>;
  /** Makes the key name (a Hello prompt), replacing one of that name; its
   * public key as SubjectPublicKeyInfo DER. */
  create(name: string): Promise<KeyResult>;
  /** The key name's signature of challenge (a Hello prompt). */
  sign(name: string, challenge: Buffer): Promise<KeyResult>;
}

/** Windows Hello keys through run. */
export function helloKeysFor(run: RunPowerShell): HelloKeys {
  const op = async (script: string, env: Record<string, string>): Promise<KeyResult> => {
    try {
      return keyResult(await run(script, env));
    } catch {
      return { ok: false, error: 'failed' };
    }
  };
  return {
    async supported() {
      try {
        return (await run(KEYS_SUPPORTED_SCRIPT, {})).trim() === 'True';
      } catch {
        return false;
      }
    },
    create: async (name) => (KEY_NAME.test(name) ? op(KEY_CREATE_SCRIPT, { [KEY_NAME_VAR]: name }) : { ok: false, error: 'failed' }),
    sign: async (name, challenge) =>
      KEY_NAME.test(name) && challenge.length > 0 && challenge.length <= 1024
        ? op(KEY_SIGN_SCRIPT, { [KEY_NAME_VAR]: name, [CHALLENGE_VAR]: challenge.toString('base64') })
        : { ok: false, error: 'failed' },
  };
}

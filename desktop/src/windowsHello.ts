// Windows Hello through PowerShell and the Windows.Security.Credentials.UI
// UserConsentVerifier. UNVERIFIED ON WINDOWS: it was written without a
// Windows machine to run it on, and only its arguments and its reading of
// the output are tested. To check there:
//   - the prompt comes to the front of the app's window, not behind it (a
//     window of a hidden powershell.exe may not be allowed to take focus);
//   - a restricted PowerShell (constrained language mode, a policy that
//     blocks Add-Type) ends non-zero and so counts as unavailable;
//   - cancelling, a wrong PIN and a machine without Hello each answer false.

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

// Awaits a WinRT operation through System.WindowsRuntimeSystemExtensions'
// AsTask, and ends non-zero on any error.
const PRELUDE = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  } | Select-Object -First 1
  function Wait-Operation($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
  }
`;
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

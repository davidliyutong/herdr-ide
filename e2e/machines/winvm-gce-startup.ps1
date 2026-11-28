# Startup script of a Windows test host on Google Compute Engine
# (`winvm.py gce create`). GCE runs it as SYSTEM at every boot, so every
# step checks for itself and a step added later reaches a host prepared
# before it at its next boot. It gives the host what `winvm.py test --host`
# needs, as the CI workflow's Windows runners have it: OpenSSH Server with
# the key of the instance's metadata (winvm-ssh-key) for a local
# administrator, PowerShell 7, Git for Windows (whose bash runs the
# suites), Node, pnpm through corepack and Bun, all machine-wide.
#
# winvm.py fills in PLACEHOLDER_USER, PLACEHOLDER_NODE_MAJOR,
# PLACEHOLDER_PNPM and PLACEHOLDER_BUN from the repository (the CI
# workflow's Node, backend/package.json's packageManager, BUN_VERSION).
#
# Pitfalls met before, kept away here:
# - It runs as SYSTEM: nothing goes to $env:USERPROFILE (SYSTEM's), every
#   tool is installed machine-wide and put on the machine Path.
# - Windows PowerShell 5.1 hands a JSON array on as one object: an
#   Invoke-RestMethod whose answer is an array is put in parentheses before
#   it is piped.
# - Windows Server ships the OpenSSH firewall rule disabled: it is enabled,
#   on every profile (GCE's network is Public); GCE's firewall admits only
#   IAP to port 22.
# - corepack asks before it downloads a package manager: it is told not to.
# - corepack keeps its default pnpm per user (SYSTEM's is no one else's):
#   COREPACK_HOME is the machine's, so the pinned pnpm is every user's
#   default, also where no package.json pins one (`pnpm -C backend …` run
#   at the repository's root, as the suites run it).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Start-Transcript -Path 'C:\winvm-provision.log' -Append | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$User = 'PLACEHOLDER_USER'
$NodeMajor = 'PLACEHOLDER_NODE_MAJOR'
$PnpmVersion = 'PLACEHOLDER_PNPM'
$BunVersion = 'PLACEHOLDER_BUN'
$Tools = 'C:\tools'
New-Item -ItemType Directory -Force $Tools | Out-Null

function Meta($key) {
  Invoke-RestMethod -Headers @{ 'Metadata-Flavor' = 'Google' } "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$key"
}
function Add-MachinePath($dir) {
  $p = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($p -split ';') -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', "$p;$dir", 'Machine') }
  if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$env:Path;$dir" }
}
# The newest release asset of a GitHub repository whose name matches.
function Release-Asset($repo, $pattern) {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
  ($rel.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1)
}

# 1. The administrator ssh logs in as; its password is random and never used.
if (-not (Get-LocalUser -Name $User -ErrorAction SilentlyContinue)) {
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%+='
  $pw = -join (1..32 | ForEach-Object { $chars | Get-Random })
  New-LocalUser -Name $User -Password (ConvertTo-SecureString $pw -AsPlainText -Force) -PasswordNeverExpires | Out-Null
  Add-LocalGroupMember -Group 'Administrators' -Member $User
}

# 2. OpenSSH Server, key-only, for administrators through
#    administrators_authorized_keys.
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
}
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
$cfg = 'C:\ProgramData\ssh\sshd_config'
$text = Get-Content -Raw $cfg
foreach ($kv in @(@('PasswordAuthentication', 'no'), @('PubkeyAuthentication', 'yes'))) {
  $line = "$($kv[0]) $($kv[1])"
  if ($text -match "(?m)^[ \t]*#?[ \t]*$($kv[0])\b.*$") { $text = $text -replace "(?m)^[ \t]*#?[ \t]*$($kv[0])\b.*$", $line }
  else { $text = "$line`r`n$text" }
}
Set-Content -Path $cfg -Value $text -Encoding ascii
$adminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
Set-Content -Path $adminKeys -Value (Meta 'winvm-ssh-key').Trim() -Encoding ascii
icacls $adminKeys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) {
  Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Any -Action Allow
} else {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Profile Any -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
Restart-Service sshd

# 3. Long paths (node_modules), and corepack without questions.
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -Type DWord
[Environment]::SetEnvironmentVariable('COREPACK_ENABLE_DOWNLOAD_PROMPT', '0', 'Machine')

# 4. PowerShell 7 (the latest stable release).
if (-not (Test-Path "$env:ProgramFiles\PowerShell\7\pwsh.exe")) {
  $asset = Release-Asset 'PowerShell/PowerShell' '^PowerShell-[\d.]+-win-x64\.msi$'
  $msi = "$env:TEMP\$($asset.name)"
  Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $msi
  Start-Process msiexec.exe -ArgumentList '/i', $msi, '/qn', '/norestart', 'ADD_PATH=1', 'REGISTER_MANIFEST=1', 'USE_MU=0', 'ENABLE_MU=0' -Wait
}
Add-MachinePath "$env:ProgramFiles\PowerShell\7"

# 5. Git for Windows (the latest release), with its bash.
if (-not (Test-Path "$env:ProgramFiles\Git\bin\bash.exe")) {
  $asset = Release-Asset 'git-for-windows/git' '^Git-[\d.]+-64-bit\.exe$'
  $exe = "$env:TEMP\$($asset.name)"
  Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $exe
  Start-Process $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES' -Wait
}
Add-MachinePath "$env:ProgramFiles\Git\cmd"
Add-MachinePath "$env:ProgramFiles\Git\bin"
& "$env:ProgramFiles\Git\cmd\git.exe" config --system core.longpaths true

# 6. Node (the newest of its major) and pnpm through corepack.
if (-not (Test-Path "$env:ProgramFiles\nodejs\node.exe")) {
  $v = ((Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1).version
  $msi = "$env:TEMP\node-$v-x64.msi"
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$v/node-$v-x64.msi" -OutFile $msi
  Start-Process msiexec.exe -ArgumentList '/i', $msi, '/qn', '/norestart' -Wait
}
Add-MachinePath "$env:ProgramFiles\nodejs"
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
$corepackHome = "$Tools\corepack"
New-Item -ItemType Directory -Force $corepackHome | Out-Null
[Environment]::SetEnvironmentVariable('COREPACK_HOME', $corepackHome, 'Machine')
$env:COREPACK_HOME = $corepackHome
& "$env:ProgramFiles\nodejs\corepack.cmd" enable
& "$env:ProgramFiles\nodejs\corepack.cmd" install --global "pnpm@$PnpmVersion"

# 7. Bun.
$bunDir = "$Tools\bun"
$bunNow = if (Test-Path "$bunDir\bun.exe") { (& "$bunDir\bun.exe" --version).Trim() } else { '' }
if ($bunNow -ne $BunVersion) {
  $zip = "$env:TEMP\bun-windows-x64-baseline.zip"
  Invoke-WebRequest -UseBasicParsing "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-windows-x64-baseline.zip" -OutFile $zip
  Expand-Archive -Force $zip "$env:TEMP\bun"
  New-Item -ItemType Directory -Force $bunDir | Out-Null
  Copy-Item -Force "$env:TEMP\bun\bun-windows-x64-baseline\bun.exe" "$bunDir\bun.exe"
}
Add-MachinePath $bunDir

# 8. Defender scanning every file pnpm writes makes installs crawl: the
#    test user's home (where winvm.py unpacks each run) is excluded.
Add-MpPreference -ExclusionPath "C:\Users\$User" -ErrorAction SilentlyContinue

# New sessions get the machine Path; the mark says a preparation finished.
Restart-Service sshd
Set-Content -Path 'C:\winvm-ready' -Value (Get-Date -Format o) -Encoding ascii
Stop-Transcript | Out-Null

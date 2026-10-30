<#
.SYNOPSIS
Sets up a Windows 11 machine for LetAgents development. Safe to run again.

.DESCRIPTION
Each part checks what is already there and skips it. Every download is
checked against a pinned SHA-256 (or, for Microsoft's bootstrapper, which
changes with each release, against its Authenticode signer) before it runs.
See docs/windows-development.md for the whole procedure.

  -Tools         (no admin) Node.js 22 x64, Git for Windows (portable, with
                 Git Bash) and the GitHub CLI under %LOCALAPPDATA%\Programs,
                 plus the user PATH and global Git settings.
  -BuildTools    (admin)    Visual Studio 2026 Build Tools with the MSVC x64
                 and ARM64 compilers and the Windows 11 SDK, and
                 LongPathsEnabled. Run from an elevated PowerShell.
  -Dependencies  (no admin) npm ci in every dependency tree, as CI does:
                 installs without lifecycle scripts, checks the registry
                 signatures, then runs the lifecycle scripts and fetches
                 Electron.
  -Providers     (no admin) the provider CLIs: Claude Code, Codex, OpenCode
                 and the Cursor agent. Nothing signs in.

With no switch it runs -Tools.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-dev.ps1 -Tools -Dependencies
#>
param(
  [switch]$Tools,
  [switch]$BuildTools,
  [switch]$Dependencies,
  [switch]$Providers,
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not ($Tools -or $BuildTools -or $Dependencies -or $Providers)) { $Tools = $true }

# Pinned versions. Node matches CI's actions/setup-node '22' on windows-latest.
# Node is x64 on every machine: the sealed native pieces (process-tree helper,
# daemon pipe addon) have x64 seals only, and the app ships x64.
$NodeVersion = '22.23.4'
$NodeSha256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
$GitVersion = '2.56.0.4'
$GitSha256 = @{
  x64   = 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1'
  arm64 = '044110f9d951858452ddb5e4b5415ea0f2b5b2598e794d6fec77fe28b9aa8cc0'
}
$GhVersion = '2.103.3'
$GhSha256 = @{
  amd64 = '98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0'
  arm64 = '197211c98687d7770ac331fe8a3b6c198c389108c1536cdbedf659fe4703e484'
}
$VsBootstrapper = 'https://aka.ms/vs/18/stable/vs_BuildTools.exe'
$VsComponents = @(
  'Microsoft.VisualStudio.Workload.VCTools',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
  'Microsoft.VisualStudio.Component.Windows11SDK.26100'
)

$Programs = Join-Path $env:LOCALAPPDATA 'Programs'
$NodeHome = Join-Path $Programs "node-v$NodeVersion-win-x64"
$GitHome = Join-Path $Programs 'Git'
$GhHome = Join-Path $Programs "gh-$GhVersion"
$NpmGlobal = Join-Path $env:APPDATA 'npm'

function Step([string]$Text) { Write-Host "==> $Text" }

# The machine's own architecture, also from an emulated x64 PowerShell.
function Get-MachineArch {
  $native = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
  if ($native -eq 'ARM64') { 'arm64' } else { 'x64' }
}

function Get-Download([string]$Url, [string]$Name, [string]$Sha256) {
  $dir = Join-Path $env:LOCALAPPDATA 'letagents-dev-setup\downloads'
  New-Item -ItemType Directory -Force $dir | Out-Null
  $file = Join-Path $dir $Name
  if (-not ((Test-Path $file) -and ((Get-FileHash $file -Algorithm SHA256).Hash -eq $Sha256))) {
    & curl.exe -sSL --fail --retry 3 -o $file $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
  }
  $actual = (Get-FileHash $file -Algorithm SHA256).Hash
  if ($actual -ne $Sha256) {
    Remove-Item -Force $file
    throw "SHA-256 of $Name is $actual, expected $Sha256."
  }
  $file
}

function Assert-Signed([string]$File, [string]$Organization) {
  $signature = Get-AuthenticodeSignature $File
  $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
  # The subject quotes a name that holds a comma: O="GitHub, Inc.".
  if ($signature.Status -ne 'Valid' -or $subject -notmatch ('(^|, )O="?' + [regex]::Escape($Organization) + '"?(,|$)')) {
    throw "$File is not signed by $Organization (status $($signature.Status), signer '$subject')."
  }
}

# Puts the entries first on the user PATH, once each, and drops the entries
# that match $Remove (older versions of the same tools).
function Set-UserPath([string[]]$Entries, [string]$Remove) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $kept = @($current -split ';' | Where-Object { $_ -and ($Entries -notcontains $_) -and -not ($Remove -and $_ -match $Remove) })
  $next = (@($Entries) + $kept) -join ';'
  if ($next -ne $current) { [Environment]::SetEnvironmentVariable('Path', $next, 'User') }
  $env:Path = ((@($Entries) + @($env:Path -split ';' | Where-Object { $_ -and ($Entries -notcontains $_) })) -join ';')
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $Repo) {
  Push-Location $WorkingDirectory
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') exited with $LASTEXITCODE." }
  } finally { Pop-Location }
}

function Install-Tools {
  $arch = Get-MachineArch

  Step "Node.js $NodeVersion x64"
  if (-not (Test-Path (Join-Path $NodeHome 'node.exe'))) {
    $zip = Get-Download "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" "node-v$NodeVersion-win-x64.zip" $NodeSha256
    Expand-Archive -Path $zip -DestinationPath $Programs -Force
  }
  Assert-Signed (Join-Path $NodeHome 'node.exe') 'OpenJS Foundation'
  New-Item -ItemType Directory -Force $NpmGlobal | Out-Null

  Step "Git for Windows $GitVersion ($arch, portable, with Git Bash)"
  $git = Join-Path $GitHome 'cmd\git.exe'
  $haveGit = (Test-Path $git) -and ((& $git --version) -match [regex]::Escape("git version $($GitVersion -replace '\.(\d+)$', '.windows.$1')"))
  if (-not $haveGit) {
    $name = if ($arch -eq 'arm64') { "PortableGit-$GitVersion-arm64.7z.exe" } else { "PortableGit-$GitVersion-64-bit.7z.exe" }
    $tag = "v$($GitVersion -replace '\.(\d+)$', '.windows.$1')"
    $sfx = Get-Download "https://github.com/git-for-windows/git/releases/download/$tag/$name" $name $GitSha256[$arch]
    Assert-Signed $sfx 'Johannes Schindelin'
    if (Test-Path $GitHome) { Remove-Item -Recurse -Force $GitHome }
    $process = Start-Process -FilePath $sfx -ArgumentList @("-o`"$GitHome`"", '-y') -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "PortableGit extraction exited with $($process.ExitCode)." }
    # The self-extractor runs post-install.bat itself, and the script deletes
    # itself when done. If it is still there, setup did not finish.
    if (Test-Path (Join-Path $GitHome 'post-install.bat')) {
      $process = Start-Process -FilePath (Join-Path $GitHome 'git-bash.exe') -ArgumentList @('--no-needs-console', '--hide', '--no-cd', '--command=post-install.bat') -WorkingDirectory $GitHome -Wait -PassThru -WindowStyle Hidden
      if (Test-Path (Join-Path $GitHome 'post-install.bat')) { throw "PortableGit post-install.bat did not finish (exit $($process.ExitCode))." }
    }
  }
  Assert-Signed $git 'Johannes Schindelin'

  Step "GitHub CLI $GhVersion"
  $ghArch = if ($arch -eq 'arm64') { 'arm64' } else { 'amd64' }
  if (-not (Test-Path (Join-Path $GhHome 'bin\gh.exe'))) {
    $zip = Get-Download "https://github.com/cli/cli/releases/download/v$GhVersion/gh_${GhVersion}_windows_$ghArch.zip" "gh_${GhVersion}_windows_$ghArch.zip" $GhSha256[$ghArch]
    Expand-Archive -Path $zip -DestinationPath $GhHome -Force
  }
  Assert-Signed (Join-Path $GhHome 'bin\gh.exe') 'GitHub, Inc.'

  Step 'User PATH and global Git settings'
  # Older Node and gh folders from this script, and a MinGit, give way.
  Set-UserPath @($NodeHome, $NpmGlobal, (Join-Path $GitHome 'cmd'), (Join-Path $GhHome 'bin')) '\\(node-v\d[^\\]*-win-x64|gh-\d[^\\]*\\bin|MinGit\\cmd)$'
  & $git config --global core.autocrlf false
  & $git config --global core.longpaths true

  & (Join-Path $NodeHome 'node.exe') --version
  & $git --version
  & (Join-Path $GhHome 'bin\gh.exe') --version | Select-Object -First 1
}

function Install-BuildTools {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '-BuildTools needs an elevated PowerShell (Run as administrator).'
  }

  Step 'LongPathsEnabled'
  Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -Type DWord

  Step 'Visual Studio 2026 Build Tools (MSVC x64 + ARM64, Windows 11 SDK 26100)'
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  $installed = if (Test-Path $vswhere) {
    & $vswhere -products * -version '[18.0,19.0)' -requires $VsComponents -property installationPath
  }
  if ($installed) {
    "Already installed at $installed"
    return
  }
  $dir = Join-Path $env:ProgramData 'letagents-dev-setup'
  New-Item -ItemType Directory -Force $dir | Out-Null
  $bootstrapper = Join-Path $dir 'vs_BuildTools.exe'
  & curl.exe -sSL --fail --retry 3 -o $bootstrapper $VsBootstrapper
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $VsBootstrapper" }
  Assert-Signed $bootstrapper 'Microsoft Corporation'
  $arguments = @('--quiet', '--wait', '--norestart', '--nocache') + ($VsComponents | ForEach-Object { '--add', $_ })
  $process = Start-Process -FilePath $bootstrapper -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  # 3010 = installed, a restart is pending.
  if ($process.ExitCode -notin 0, 3010) { throw "vs_BuildTools.exe exited with $($process.ExitCode); see %TEMP%\dd_*.log." }
  "vs_BuildTools.exe exited with $($process.ExitCode)"
}

function Install-Dependencies {
  $npm = Join-Path $NodeHome 'npm.cmd'
  if (-not (Test-Path $npm)) { throw 'Run -Tools first: Node.js is missing.' }
  $env:Path = "$NodeHome;$env:Path"
  $retry = Join-Path $Repo 'scripts\retry-command.mjs'

  foreach ($tree in @('.', 'apps/desktop', 'src/web', 'apps/desktop/electron/runtime/letagents')) {
    $at = Join-Path $Repo $tree
    Step "npm ci in $tree (no lifecycle scripts) and npm audit signatures"
    Invoke-Checked 'node' @($retry, 'npm', 'ci', '--ignore-scripts', '--no-audit') $at
    Invoke-Checked 'node' @($retry, 'npm', 'audit', 'signatures') $at
  }

  Step 'Verified lifecycle scripts and Electron'
  Invoke-Checked $npm @('rebuild')
  Invoke-Checked $npm @('rebuild', '--prefix', 'apps/desktop')
  Invoke-Checked $npm @('rebuild') (Join-Path $Repo 'src/web')
  Invoke-Checked $npm @('exec', '--prefix', 'apps/desktop', '--', 'install-electron')
}

function Install-Providers {
  $npm = Join-Path $NodeHome 'npm.cmd'
  if (-not (Test-Path $npm)) { throw 'Run -Tools first: Node.js is missing.' }
  $env:Path = "$NodeHome;$NpmGlobal;$env:Path"

  Step 'Codex and OpenCode (npm global packages, in the Node folder)'
  Invoke-Checked $npm @('install', '--global', '@openai/codex', 'opencode-ai') $env:USERPROFILE

  Step 'Claude Code (native installer; it checks the binary against its manifest)'
  $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (-not (Test-Path $claude)) {
    Invoke-Expression (Invoke-RestMethod -Uri 'https://claude.ai/install.ps1')
  }
  Set-UserPath @((Join-Path $env:USERPROFILE '.local\bin')) $null

  Step 'Cursor agent (official installer, %LOCALAPPDATA%\cursor-agent)'
  if (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'cursor-agent\cursor-agent.cmd'))) {
    Invoke-Expression (Invoke-RestMethod -Uri 'https://cursor.com/install?win32=true')
  }
}

if ($BuildTools) { Install-BuildTools }
if ($Tools) { Install-Tools }
if ($Dependencies) { Install-Dependencies }
if ($Providers) { Install-Providers }
Step 'Done. Open a new terminal so the PATH changes apply.'

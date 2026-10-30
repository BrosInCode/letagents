<#
.SYNOPSIS
Sets up a Windows 11 machine for LetAgents development. Safe to run again.

.DESCRIPTION
Each part checks what is already there and skips it. Every download of
-Tools is checked against a pinned SHA-256, and each program in it against
its Authenticode signer; Microsoft's bootstrapper, which changes with each
release, is checked by its signer only. -Providers is the exception: it runs
the vendors' own installers (see below). See docs/windows-development.md.

  -Tools         (no admin) Node.js 22 x64, Git for Windows (portable, with
                 Git Bash) and the GitHub CLI, each in its own versioned
                 folder under %LOCALAPPDATA%\Programs, plus the user PATH and
                 the global Git settings.
  -BuildTools    (admin)    Visual Studio 2026 Build Tools with the MSVC x64
                 and ARM64 compilers and the Windows 11 SDK, and
                 LongPathsEnabled. Run from an elevated PowerShell. It warns
                 when the default MSVC or the SDK is not the one the native
                 seals name: such a compiler builds bytes the app refuses.
  -Dependencies  (no admin) npm ci in every dependency tree, as CI does:
                 installs without lifecycle scripts, checks the registry
                 signatures, then runs the lifecycle scripts and fetches
                 Electron. A tree whose lock file, Node and setup are
                 unchanged since its last setup is skipped; -Force redoes it.
  -Providers     (no admin) the provider CLIs, nothing signed in: Codex and
                 OpenCode from npm at pinned versions (OpenCode at the
                 repository's letagentsRuntime.openCodeVersion), Claude Code
                 and the Cursor agent through the vendors' own install
                 scripts. Those scripts are not pinned: they are fetched over
                 HTTPS and run as published (Claude's checks its binary's
                 SHA-256 against its manifest; Cursor's checks nothing).

With no switch it runs -Tools.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-dev.ps1 -Tools -Dependencies
#>
param(
  [switch]$Tools,
  [switch]$BuildTools,
  [switch]$Dependencies,
  [switch]$Providers,
  [switch]$Force,
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
$CodexVersion = '0.166.0'
# What shared/letagents-*.seal.json name; the native builds use the default toolset.
$SealedVcTools = '14.51.36231'
$SealedWindowsSdk = '10.0.26100.0'
$VsBootstrapper = 'https://aka.ms/vs/18/stable/vs_BuildTools.exe'
$VsComponents = @(
  'Microsoft.VisualStudio.Workload.VCTools',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
  'Microsoft.VisualStudio.Component.Windows11SDK.26100'
)

$Programs = Join-Path $env:LOCALAPPDATA 'Programs'
$NodeHome = Join-Path $Programs "node-v$NodeVersion-win-x64"
$GitHome = Join-Path $Programs "PortableGit-$GitVersion"
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
# that match $Remove (older versions of the same tools). The value is read and
# written as stored, so entries such as %JAVA_HOME%\bin stay unexpanded.
function Set-UserPath([string[]]$Entries, [string]$Remove) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try {
    $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kept = @($current -split ';' | Where-Object { $_ -and ($Entries -notcontains $_) -and -not ($Remove -and $_ -match $Remove) })
    $next = (@($Entries) + $kept) -join ';'
    if ($next -ne $current) {
      $key.SetValue('Path', $next, [Microsoft.Win32.RegistryValueKind]::ExpandString)
      # Tell Explorer, so terminals started from now on see the new PATH.
      if (-not ('LetAgentsSetup.Broadcast' -as [type])) {
        Add-Type -Namespace LetAgentsSetup -Name Broadcast -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
      }
      $result = [UIntPtr]::Zero
      [LetAgentsSetup.Broadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
    }
  } finally { $key.Close() }
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
    # Extracted beside its final folder, which only a finished setup takes the
    # place of; the versioned folder is this script's own, so nothing of
    # another Git is removed.
    $partial = "$GitHome.partial"
    if (Test-Path $partial) { Remove-Item -Recurse -Force $partial }
    if (Test-Path $GitHome) { throw "$GitHome exists but holds no working Git $GitVersion; remove it and run again." }
    $process = Start-Process -FilePath $sfx -ArgumentList @("-o`"$partial`"", '-y') -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "PortableGit extraction exited with $($process.ExitCode)." }
    # The self-extractor runs post-install.bat itself, and the script deletes
    # itself when done. If it is still there, setup did not finish.
    if (Test-Path (Join-Path $partial 'post-install.bat')) {
      $process = Start-Process -FilePath (Join-Path $partial 'git-bash.exe') -ArgumentList @('--no-needs-console', '--hide', '--no-cd', '--command=post-install.bat') -WorkingDirectory $partial -Wait -PassThru -WindowStyle Hidden
      if (Test-Path (Join-Path $partial 'post-install.bat')) { throw "PortableGit post-install.bat did not finish (exit $($process.ExitCode))." }
    }
    Rename-Item $partial (Split-Path $GitHome -Leaf)
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
  # Older Node, Git and gh folders of this script, and a MinGit, all under
  # %LOCALAPPDATA%\Programs, give way; nothing else is removed.
  Set-UserPath @($NodeHome, $NpmGlobal, (Join-Path $GitHome 'cmd'), (Join-Path $GhHome 'bin')) ('^' + [regex]::Escape($Programs) + '\\(node-v\d[^\\]*-win-x64|PortableGit-\d[^\\]*\\cmd|gh-\d[^\\]*\\bin|MinGit\\cmd)\\?$')
  Invoke-Checked $git @('config', '--global', 'core.autocrlf', 'false') $env:USERPROFILE
  Invoke-Checked $git @('config', '--global', 'core.longpaths', 'true') $env:USERPROFILE

  # Windows puts the machine PATH before the user PATH: a tool there wins.
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  foreach ($tool in 'node.exe', 'git.exe', 'gh.exe') {
    $shadow = @($machinePath -split ';' | Where-Object {
      try { $_ -and (Test-Path -LiteralPath (Join-Path ([Environment]::ExpandEnvironmentVariables($_)) $tool)) } catch { $false }
    }) | Select-Object -First 1
    if ($shadow) { Write-Warning "$tool in $shadow (machine PATH) comes before the user PATH, so new terminals start that one. Remove that folder from the machine PATH, or uninstall that tool." }
  }

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
  } else {
    # A new folder in the elevated user's own TEMP, which no other user can write.
    $dir = Join-Path $env:TEMP ('letagents-vs-' + [guid]::NewGuid())
    New-Item -ItemType Directory $dir | Out-Null
    $bootstrapper = Join-Path $dir 'vs_BuildTools.exe'
    & curl.exe -sSL --fail --retry 3 -o $bootstrapper $VsBootstrapper
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $VsBootstrapper" }
    Assert-Signed $bootstrapper 'Microsoft Corporation'
    $arguments = @('--quiet', '--wait', '--norestart', '--nocache') + ($VsComponents | ForEach-Object { '--add', $_ })
    $process = Start-Process -FilePath $bootstrapper -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    # 3010 = installed, a restart is pending.
    if ($process.ExitCode -notin 0, 3010) { throw "vs_BuildTools.exe exited with $($process.ExitCode); see %TEMP%\dd_*.log." }
    "vs_BuildTools.exe exited with $($process.ExitCode)"
    $installed = & $vswhere -products * -version '[18.0,19.0)' -requires $VsComponents -property installationPath
    if (-not $installed) { throw 'Visual Studio Build Tools did not install the required components.' }
  }

  # build.mjs uses vcvarsall's default toolset. Another MSVC or SDK still
  # builds, but not the sealed bytes, and the app refuses what it builds.
  $installation = @($installed)[0]
  $default = (Get-Content (Join-Path $installation 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt') -ErrorAction SilentlyContinue | Select-Object -First 1)
  $sdk = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Include\$SealedWindowsSdk"
  if ($default -ne $SealedVcTools -or -not (Test-Path $sdk)) {
    Write-Warning ("The default MSVC is '$default' and SDK $SealedWindowsSdk is " + $(if (Test-Path $sdk) { 'present' } else { 'missing' }) +
      "; the native seals name MSVC $SealedVcTools with SDK $SealedWindowsSdk. Local builds of the process-tree helper and the" +
      ' daemon pipe addon will not match their seals: use the CI-built pieces, or reseal in a pull request.')
  } else {
    "MSVC $default and SDK $SealedWindowsSdk match the native seals."
  }
}

function Install-Dependencies {
  $npm = Join-Path $NodeHome 'npm.cmd'
  if (-not (Test-Path $npm)) { throw 'Run -Tools first: Node.js is missing.' }
  $env:Path = "$NodeHome;$env:Path"
  $retry = Join-Path $Repo 'scripts\retry-command.mjs'
  # The tree's lock file and this Node, written once the whole tree is set up.
  $stampOf = { param($at) "$((Get-FileHash (Join-Path $at 'package-lock.json') -Algorithm SHA256).Hash) node-$NodeVersion-x64 setup-1" }
  $stampPath = { param($at) Join-Path $at 'node_modules\.letagents-dev-setup' }

  $trees = @('.', 'apps/desktop', 'src/web', 'apps/desktop/electron/runtime/letagents')
  $changed = @()
  foreach ($tree in $trees) {
    $at = Join-Path $Repo $tree
    $stamp = & $stampPath $at
    if (-not $Force -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq (& $stampOf $at))) {
      Step "$tree is set up for its lock file; skipped (-Force redoes it)"
      continue
    }
    Step "npm ci in $tree (no lifecycle scripts) and npm audit signatures"
    Invoke-Checked 'node' @($retry, 'npm', 'ci', '--ignore-scripts', '--no-audit') $at
    Invoke-Checked 'node' @($retry, 'npm', 'audit', 'signatures') $at
    $changed += $tree
  }

  $electron = Join-Path $Repo 'apps\desktop\node_modules\electron\dist\electron.exe'
  if ($changed.Count -or -not (Test-Path $electron)) {
    Step 'Verified lifecycle scripts and Electron'
    if ($changed -contains '.') { Invoke-Checked $npm @('rebuild') }
    if ($changed -contains 'apps/desktop') { Invoke-Checked $npm @('rebuild', '--prefix', 'apps/desktop') }
    if ($changed -contains 'src/web') { Invoke-Checked $npm @('rebuild') (Join-Path $Repo 'src/web') }
    Invoke-Checked $npm @('exec', '--prefix', 'apps/desktop', '--', 'install-electron')
  }
  foreach ($tree in $changed) {
    $at = Join-Path $Repo $tree
    Set-Content -Path (& $stampPath $at) -Value (& $stampOf $at) -Encoding ascii
  }
}

function Install-Providers {
  $npm = Join-Path $NodeHome 'npm.cmd'
  if (-not (Test-Path $npm)) { throw 'Run -Tools first: Node.js is missing.' }
  $env:Path = "$NodeHome;$NpmGlobal;$env:Path"

  # OpenCode at the version the app's OpenCode contract names.
  $desktopPackage = Get-Content (Join-Path $Repo 'apps\desktop\package.json') -Raw | ConvertFrom-Json
  $openCodeVersion = $desktopPackage.letagentsRuntime.openCodeVersion
  foreach ($package in @(@('@openai/codex', $CodexVersion), @('opencode-ai', $openCodeVersion))) {
    $name, $version = $package
    Step "$name $version (npm global package, in the Node folder)"
    $manifest = Join-Path $NodeHome "node_modules\$name\package.json"
    if ((Test-Path $manifest) -and ((Get-Content $manifest -Raw | ConvertFrom-Json).version -eq $version)) { continue }
    Invoke-Checked $npm @('install', '--global', "$name@$version") $env:USERPROFILE
  }

  # The vendors' own install scripts, as published (not pinned), each in its
  # own PowerShell, so that it cannot change or end this one.
  $vendorInstall = {
    param([string]$Url)
    & powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod -Uri '$Url' | Invoke-Expression"
    if ($LASTEXITCODE -ne 0) { throw "The installer from $Url exited with $LASTEXITCODE." }
  }
  Step 'Claude Code (native installer; it checks the binary against its manifest)'
  if (-not (Test-Path (Join-Path $env:USERPROFILE '.local\bin\claude.exe'))) { & $vendorInstall 'https://claude.ai/install.ps1' }
  Set-UserPath @((Join-Path $env:USERPROFILE '.local\bin')) $null

  Step 'Cursor agent (official installer, %LOCALAPPDATA%\cursor-agent)'
  if (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'cursor-agent\cursor-agent.cmd'))) { & $vendorInstall 'https://cursor.com/install?win32=true' }
}

if ($BuildTools) { Install-BuildTools }
if ($Tools) { Install-Tools }
if ($Dependencies) { Install-Dependencies }
if ($Providers) { Install-Providers }
Step 'Done. Open a new terminal so the PATH changes apply.'

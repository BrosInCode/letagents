; LetAgents for Windows: a per-user NSIS installer.
;
; Built by electron/scripts/package-windows.mjs, which passes:
;   VERSION        x.y.z
;   FILE_VERSION   x.y.z.0
;   SOURCE_DIR     the packaged app folder (release/LetAgents-win32/LetAgents)
;   PAYLOAD_NSH    the generated include with REMOVE_LETAGENTS_PAYLOAD
;   ICON_FILE      the app icon (.ico)
;   OUTPUT_FILE    the installer to write
;   HELPER_NAME    the process-tree helper's file name, in RUNTIME_DIR
;   INSTALLED_KB   the payload's size, for Installed apps
;
; It installs to %LOCALAPPDATA%\Programs\LetAgents without administrator
; rights. electron-updater's NsisUpdater runs the next version's installer
; with `--updated` (and `--force-run` to start the app again, `/S` when
; silent); this script honours those flags the way electron-builder's NSIS
; installers do. The installer and the app are not code-signed yet, so
; Windows SmartScreen asks first-time users to choose More info -> Run anyway.

Unicode true
ManifestDPIAware true
; Not /SOLID: each file is compressed on its own, so files that did not change
; between versions keep the same bytes and the differential update can reuse
; them through the installer's blockmap.
SetCompressor lzma
RequestExecutionLevel user

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "${PAYLOAD_NSH}"

!define PRODUCT_NAME "LetAgents"
; The AppUserModelID: also WINDOWS_APP_USER_MODEL_ID in
; electron/main/windows-app-identity.ts, which the app sets on its process.
!define APP_ID "chat.letagents.desktop"
!define EXE_NAME "LetAgents.exe"
!define UNINSTALLER_NAME "Uninstall LetAgents.exe"
; Programs the app runs from its own folder besides LetAgents.exe.
!define RUNTIME_DIR "resources\app\runtime"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!define URL_KEY "Software\Classes\letagents"
; Must match updaterCacheDirName in resources\app-update.yml.
!define UPDATER_CACHE "letagents-desktop-updater"

Name "${PRODUCT_NAME}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
; An update or reinstall goes where the app is installed now, also after a
; first install with a custom /D= folder.
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
ShowInstDetails nevershow
ShowUninstDetails nevershow
BrandingText "${PRODUCT_NAME} ${VERSION}"

VIProductVersion "${FILE_VERSION}"
VIFileVersion "${FILE_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey /LANG=1033 "CompanyName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright © LetAgents"

Var Updating
Var ForceRun
Var InstalledHere

!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipWhenUpdating
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE_NAME}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${PRODUCT_NAME}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; Clears $R2 when FILE is in use. A running program's file cannot be opened
; for writing, which is the test.
!macro CHECK_NOT_RUNNING FILE
  ${If} ${FileExists} "${FILE}"
    ClearErrors
    FileOpen $R0 "${FILE}" a
    ${If} ${Errors}
      StrCpy $R2 0
    ${Else}
      FileClose $R0
    ${EndIf}
  ${EndIf}
!macroend

; Stops each program running from $INSTDIR\resources: an agent's process-tree
; helper keeps running when the app and its daemon have quit (stopping it
; ends the agent processes in its job), and a model probe's opencode.exe runs
; on its own. Only the app's own resources folder, so a /D= install into a
; shared folder stops nothing else there, and helpers of any other LetAgents
; copy are left alone. WMI reads each process's path also from this 32-bit
; installer; no cmdlets, which can take many seconds to load. The folder
; reaches PowerShell through the environment, so no path is quoted on its
; command line. Where PowerShell cannot run this (blocked, or Constrained
; Language Mode), the helpers are stopped by name instead.
!macro STOP_PROGRAMS_IN_INSTDIR
  System::Call 'Kernel32::SetEnvironmentVariable(t "LETAGENTS_STOP_IN", t "$INSTDIR\resources")'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $$root = $$env:LETAGENTS_STOP_IN + '\'; foreach ($$p in ([wmisearcher]'SELECT ProcessId, ExecutablePath FROM Win32_Process').Get()) { $$x = $$p.ExecutablePath; if ($$x -and $$x.StartsWith($$root, [StringComparison]::OrdinalIgnoreCase)) { try { [Diagnostics.Process]::GetProcessById([int]$$p.ProcessId).Kill() } catch {} } }; exit 0 } catch { exit 1 }"`
  Pop $R0
  ; The app started with --force-run inherits this installer's environment.
  System::Call 'Kernel32::SetEnvironmentVariable(t "LETAGENTS_STOP_IN", p 0)'
  ${If} $R0 != 0
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${HELPER_NAME}"'
    Pop $R0
  ${EndIf}
!macroend

; Wait for the app to quit (electron-updater starts this installer and then
; quits the app), then stop what is still running from this folder: the app's
; own child processes run the same LetAgents.exe, and agents and probes run
; the programs STOP_PROGRAMS_IN_INSTDIR stops. taskkill by name stays as the
; fallback for LetAgents.exe; without elevation it stops only this user's
; processes. No /T: electron-updater starts this installer as a child of
; LetAgents.exe, so a tree kill would stop the installer too. A person
; running the installer by hand is asked before the app is closed.
!macro DEFINE_CLOSE_APP PREFIX
Function ${PREFIX}CloseRunningApp
  ${IfNot} ${FileExists} "$INSTDIR\${EXE_NAME}"
    Return
  ${EndIf}
  StrCpy $R1 0
  ${Do}
    StrCpy $R2 1
    !insertmacro CHECK_NOT_RUNNING "$INSTDIR\${EXE_NAME}"
    !insertmacro CHECK_NOT_RUNNING "$INSTDIR\${RUNTIME_DIR}\${HELPER_NAME}"
    !insertmacro CHECK_NOT_RUNNING "$INSTDIR\${RUNTIME_DIR}\opencode.exe"
    ${If} $R2 = 1
      Return
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 = 20
      ${If} $Updating != "1"
        MessageBox MB_OKCANCEL|MB_ICONQUESTION "${PRODUCT_NAME} or one of its agents is running. Close them and continue?" /SD IDOK IDOK close
        Abort "${PRODUCT_NAME} is still running."
        close:
      ${EndIf}
      nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM "${EXE_NAME}"'
      Pop $R0
      !insertmacro STOP_PROGRAMS_IN_INSTDIR
    ${EndIf}
    ${If} $R1 >= 40
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} is still running. Close it, then choose Retry." /SD IDCANCEL IDRETRY retry
      Abort "${PRODUCT_NAME} is still running."
      retry:
      StrCpy $R1 0
    ${EndIf}
    Sleep 500
  ${Loop}
FunctionEnd
!macroend
!insertmacro DEFINE_CLOSE_APP ""
!insertmacro DEFINE_CLOSE_APP "un."

; $INSTDIR holds LetAgents and is the folder Installed apps lists for it.
!macro DEFINE_IS_REGISTERED_INSTALL PREFIX
Function ${PREFIX}IsRegisteredInstall
  StrCpy $InstalledHere "0"
  ${IfNot} ${FileExists} "$INSTDIR\${EXE_NAME}"
    Return
  ${EndIf}
  ReadRegStr $R0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ; NSIS compares strings without case, as Windows paths are.
  ${If} $R0 == $INSTDIR
    StrCpy $InstalledHere "1"
  ${EndIf}
FunctionEnd
!macroend
!insertmacro DEFINE_IS_REGISTERED_INSTALL ""
!insertmacro DEFINE_IS_REGISTERED_INSTALL "un."

; CreateShortCut cannot set a shortcut's AppUserModelID. Windows shows a
; desktop app's toast notifications only when the process's ID matches a
; Start menu shortcut's, so the ID is written through the shell's own
; property store (NSIS's Win\COM.nsh, no plugin). Uses $0-$6.
!macro SET_SHORTCUT_APP_ID LNK
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("${LNK}",${STGM_READWRITE}).r4'
      ${If} $4 = 0
        ${IUnknown::QueryInterface} $0 '("${IID_IPropertyStore}",.r2)'
        ${If} $2 P<> 0
          System::Call 'SHLWAPI::SHStrDupW(w "${APP_ID}",*p.r5)i.r4'
          ${If} $4 = 0
            System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ID})p.r3'
            ; The whole PROPVARIANT, then its fields: giving the third field a
            ; pointer type in one call would shrink the block to 12 bytes on x86.
            System::Call '*(&i${SYSSIZEOF_PROPVARIANT})p.r6'
            System::Call '*$6(&i2 ${VT_LPWSTR},&i6,p r5)'
            ${IPropertyStore::SetValue} $2 '($3,$6)'
            ${IPropertyStore::Commit} $2 ""
            ; Frees the SHStrDupW copy too.
            System::Call 'OLE32::PropVariantClear(p r6)'
            System::Free $3
            System::Free $6
          ${EndIf}
          ${IUnknown::Release} $2 ""
        ${EndIf}
        ${IPersistFile::Save} $1 '("${LNK}",1)'
      ${EndIf}
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
!macroend

Function .onInit
  SetShellVarContext current
  ${GetParameters} $R0
  StrCpy $Updating "0"
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $Updating "1"
  ${EndIf}
  StrCpy $ForceRun "0"
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
    StrCpy $ForceRun "1"
  ${EndIf}
FunctionEnd

Function SkipWhenUpdating
  ${If} $Updating == "1"
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  Call CloseRunningApp
  ; Remove the previous version's files first, but only from the folder this
  ; user's LetAgents install is registered in, so files of the same names in
  ; any other folder are never touched.
  Call IsRegisteredInstall
  ${If} $InstalledHere == "1"
    !insertmacro REMOVE_LETAGENTS_PAYLOAD
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*"
  WriteUninstaller "$INSTDIR\${UNINSTALLER_NAME}"

  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
  !insertmacro SET_SHORTCUT_APP_ID "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  ; A user who deleted the desktop shortcut keeps it deleted across updates.
  ${If} $Updating == "0"
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
    !insertmacro SET_SHORTCUT_APP_ID "$DESKTOP\${PRODUCT_NAME}.lnk"
  ${EndIf}

  ; "Ask for an agent" links (letagents://ask/<token>) open the app.
  WriteRegStr HKCU "${URL_KEY}" "" "URL:LetAgents links"
  WriteRegStr HKCU "${URL_KEY}" "URL Protocol" ""
  WriteRegStr HKCU "${URL_KEY}\DefaultIcon" "" '"$INSTDIR\${EXE_NAME}",0'
  WriteRegStr HKCU "${URL_KEY}\shell\open\command" "" '"$INSTDIR\${EXE_NAME}" "%1"'

  ; Settings > Apps > Installed apps.
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" '"$INSTDIR\${EXE_NAME}",0'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER_NAME}"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER_NAME}" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ; From the build: counting the installed folder's files takes minutes.
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" ${INSTALLED_KB}

  ; electron-updater builds the next differential update from the installer
  ; of the installed version, which it looks for here.
  CreateDirectory "$LOCALAPPDATA\${UPDATER_CACHE}"
  CopyFiles /SILENT "$EXEPATH" "$LOCALAPPDATA\${UPDATER_CACHE}\installer.exe"
  ; A blockmap kept from an earlier download may describe another version;
  ; without it the updater fetches the installed version's own blockmap.
  Delete "$LOCALAPPDATA\${UPDATER_CACHE}\current.blockmap"

  ${If} $Updating == "1"
    SetAutoClose true
  ${EndIf}
  ${If} $ForceRun == "1"
    Exec '"$INSTDIR\${EXE_NAME}"'
  ${EndIf}
SectionEnd

; User data (%APPDATA%\LetAgents) stays, as it does when the macOS app is
; moved to the Trash.
Section "Uninstall"
  SetShellVarContext current
  Call un.CloseRunningApp
  Call un.IsRegisteredInstall
  ; An uninstaller in any other folder removes only itself: the shortcuts,
  ; links, Installed apps entry and updater cache belong to the registered
  ; install.
  ${If} $InstalledHere == "1"
    !insertmacro REMOVE_LETAGENTS_PAYLOAD
    Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    DeleteRegKey HKCU "${URL_KEY}"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    RMDir /r "$LOCALAPPDATA\${UPDATER_CACHE}"
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALLER_NAME}"
  RMDir "$INSTDIR"
SectionEnd

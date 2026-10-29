; LetAgents for Windows: a per-user NSIS installer.
;
; Built by electron/scripts/package-windows.mjs, which passes:
;   VERSION        x.y.z
;   FILE_VERSION   x.y.z.0
;   SOURCE_DIR     the packaged app folder (release/LetAgents-win32/LetAgents)
;   PAYLOAD_NSH    the generated include with REMOVE_LETAGENTS_PAYLOAD
;   ICON_FILE      the app icon (.ico)
;   OUTPUT_FILE    the installer to write
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
!include "${PAYLOAD_NSH}"

!define PRODUCT_NAME "LetAgents"
!define APP_ID "chat.letagents.desktop"
!define EXE_NAME "LetAgents.exe"
!define UNINSTALLER_NAME "Uninstall LetAgents.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!define URL_KEY "Software\Classes\letagents"
; Must match updaterCacheDirName in resources\app-update.yml.
!define UPDATER_CACHE "letagents-desktop-updater"

Name "${PRODUCT_NAME}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
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

; Wait for the app to quit (electron-updater starts this installer and then
; quits the app), then stop what is still running: the app's own child
; processes run the same LetAgents.exe. A running executable cannot be opened
; for writing, which is the test. taskkill without elevation stops only this
; user's processes.
!macro DEFINE_CLOSE_APP PREFIX
Function ${PREFIX}CloseRunningApp
  ${IfNot} ${FileExists} "$INSTDIR\${EXE_NAME}"
    Return
  ${EndIf}
  StrCpy $R1 0
  ${Do}
    ClearErrors
    FileOpen $R0 "$INSTDIR\${EXE_NAME}" a
    ${IfNot} ${Errors}
      FileClose $R0
      Return
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 = 20
      nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${EXE_NAME}"'
      Pop $R0
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
  ; Remove the previous version's files first, but only from a folder that
  ; holds a LetAgents install, so a custom /D= folder is never emptied.
  ${If} ${FileExists} "$INSTDIR\${EXE_NAME}"
    !insertmacro REMOVE_LETAGENTS_PAYLOAD
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*"
  WriteUninstaller "$INSTDIR\${UNINSTALLER_NAME}"

  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
  ; A user who deleted the desktop shortcut keeps it deleted across updates.
  ${If} $Updating == "0"
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
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
  ${GetSize} "$INSTDIR" "/S=0K" $R0 $R1 $R2
  IntFmt $R0 "0x%08X" $R0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$R0"

  ; electron-updater builds the next differential update from the installer
  ; of the installed version, which it looks for here.
  CreateDirectory "$LOCALAPPDATA\${UPDATER_CACHE}"
  CopyFiles /SILENT "$EXEPATH" "$LOCALAPPDATA\${UPDATER_CACHE}\installer.exe"

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
  ${If} ${FileExists} "$INSTDIR\${EXE_NAME}"
    !insertmacro REMOVE_LETAGENTS_PAYLOAD
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALLER_NAME}"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  DeleteRegKey HKCU "${URL_KEY}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  RMDir /r "$LOCALAPPDATA\${UPDATER_CACHE}"
SectionEnd

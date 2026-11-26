; LetAgents for Windows: a per-user NSIS installer.
;
; Built by electron/scripts/package-windows.mjs, which passes:
;   VERSION        x.y.z
;   FILE_VERSION   x.y.z.0
;   SOURCE_DIR     the packaged app folder (release/LetAgents-win32/LetAgents)
;   PAYLOAD_NSH    the generated include with REMOVE_LETAGENTS_PAYLOAD and
;                  LETAGENTS_PAYLOAD_ENTRIES
;   MANIFEST_FILE  the install manifest: every file and folder the payload has
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

!ifndef TEST_INSTANCE
!define PRODUCT_NAME "LetAgents"
; The AppUserModelID: also WINDOWS_APP_USER_MODEL_ID in
; electron/main/windows-app-identity.ts, which the app sets on its process.
!define APP_ID "chat.letagents.desktop"
!define URL_SCHEME "letagents"
; Must match updaterCacheDirName in resources\app-update.yml.
!define UPDATER_CACHE "letagents-desktop-updater"
!else
  ; windows-installer.test.mjs only: its own names, so a test install never
  ; touches a real LetAgents install, its links or its updater cache.
  !define PRODUCT_NAME "LetAgentsTest-${TEST_INSTANCE}"
  !define APP_ID "chat.letagents.desktop.test-${TEST_INSTANCE}"
  !define URL_SCHEME "letagents-test-${TEST_INSTANCE}"
  !define UPDATER_CACHE "letagents-test-${TEST_INSTANCE}-updater"
!endif
!define EXE_NAME "LetAgents.exe"
!define UNINSTALLER_NAME "Uninstall LetAgents.exe"
; Programs the app runs from its own folder besides LetAgents.exe.
!define RUNTIME_DIR "resources\app\runtime"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!define URL_KEY "Software\Classes\${URL_SCHEME}"
; An update writes the new version here first and moves the old version's
; entries here while it swaps them (see SwapInStagedPayload). No payload entry
; starts with a dot (windows-packaging.mjs), so these never clash with one.
; windows-packaging.mjs checks that the longest payload path still fits in
; MAX_PATH below STAGE_DIR (WINDOWS_STAGE_DIR there).
!define STAGE_DIR ".letagents-new"
!define BACKUP_DIR ".letagents-old"
!define MOVED_IN_LIST ".moved-in"
; Lists every file and folder the install wrote (WINDOWS_INSTALL_MANIFEST_NAME
; in electron/scripts/windows-packaging.mjs, which writes it). The payload
; include names it as a payload entry, so an update swaps it with the rest.
!define INSTALL_MANIFEST "LetAgents.install-manifest"

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
; MoveLetAgentsEntry's arguments and failure count.
Var MoveFrom
Var MoveTo
Var MoveName
Var MoveStopAtFailure
Var MoveFailures
; "1" while $INSTDIR\${STAGE_DIR} holds a new copy that is not swapped in.
Var Staging
; "1" when a failed update leaves the old version whole, so --force-run
; starts it again.
Var RestartAfterFailure
; The folder RemoveListedPayload works in: $INSTDIR, or ${BACKUP_DIR} in it.
Var PayloadRoot

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

; Stops the install or uninstall: the error level is 2 also in silent mode (/S).
!macro FAIL_INSTALL TEXT
  MessageBox MB_OK|MB_ICONSTOP "${TEXT}" /SD IDOK
  SetErrorLevel 2
  Abort "${TEXT}"
!macroend

; How an update replaces the installed version, and what each stop leaves.
; Both folders are hidden subfolders of $INSTDIR, so every move is a rename on
; one volume: it moves a whole folder at once and needs no free disk space.
;
;   1. Extract the new version into ${STAGE_DIR}.
;   2. Move the old entries from $INSTDIR into ${BACKUP_DIR}.
;   3. Write ${MOVED_IN_LIST} into ${BACKUP_DIR}: the entries step 4 moves in.
;   4. Move the new entries from ${STAGE_DIR} into $INSTDIR.
;   5. The commit: remove ${STAGE_DIR}, which is empty now.
;   6. Delete the old version in ${BACKUP_DIR}: the files its install
;      manifest lists. Anything else there (a file the user kept in a payload
;      folder) moves back into $INSTDIR, then ${BACKUP_DIR} goes.
;
; A run that stops (power loss, a killed installer) leaves this, and the next
; run of the installer or the uninstaller does this (RecoverInterruptedUpdate):
;
;   Stopped at  $INSTDIR      ${STAGE_DIR}  ${BACKUP_DIR}     Next run
;   1           old, whole    part of new   none              deletes ${STAGE_DIR}
;   2           part of old   new, whole    part of old       moves the old entries back
;   3           no new entry  new, whole    old, part list    deletes the listed entries
;                                                             (none there), moves old back
;   4           part of new   rest of new   old, list         deletes the listed (new)
;                                                             entries, moves old back
;   5, 6        new, whole    none          (part of) old     deletes ${BACKUP_DIR}
;   rollback    mixed         part of new   old, list         as for 4
;
; So both folders there means the swap was not committed and the old version
; wins in full; ${BACKUP_DIR} alone means it was, and the new version stays.
; A rollback (SwapInStagedPayload) keeps both folders until the old version
; is whole again.

; Removes what an install wrote from $PayloadRoot, as the install manifest
; there lists it: each file ("F <path>"), then each folder ("D <path>",
; deepest first) that is empty by then. A file LetAgents did not install
; stays, and so does every folder that holds one, also in a custom /D=
; folder shared with other files. A line that is not "F " or "D " and a path
; inside the folder (not empty, no leading separator, no ":" and no "..") is
; skipped. Sets $R9 to 1 when the manifest was there, else 0. Uses $R3-$R9.
!macro DEFINE_REMOVE_LISTED_PAYLOAD PREFIX
Function ${PREFIX}RemoveListedPayload
  StrCpy $R9 "0"
  ClearErrors
  FileOpen $R3 "$PayloadRoot\${INSTALL_MANIFEST}" r
  ${If} ${Errors}
    Return
  ${EndIf}
  StrCpy $R9 "1"
  ${Do}
    ClearErrors
    FileReadUTF16LE $R3 $R4
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    ; The line without its CR LF.
    ${Do}
      StrCpy $R5 $R4 1 -1
      ${If} $R5 == "$\r"
      ${OrIf} $R5 == "$\n"
        StrCpy $R4 $R4 -1
      ${Else}
        ${Break}
      ${EndIf}
    ${Loop}
    StrCpy $R5 $R4 2
    StrCpy $R6 $R4 "" 2
    StrCpy $R7 $R6 1
    ${If} $R7 == ""
    ${OrIf} $R7 == "\"
    ${OrIf} $R7 == "/"
      ${Continue}
    ${EndIf}
    System::Call 'shlwapi::StrStrW(w R6, w "..")p.R7'
    System::Call 'shlwapi::StrChrW(w R6, i 58)p.R8'
    ${If} $R7 P<> 0
    ${OrIf} $R8 P<> 0
      ${Continue}
    ${EndIf}
    ${If} $R5 S== "F "
      Delete "$PayloadRoot\$R6"
    ${ElseIf} $R5 S== "D "
      RMDir "$PayloadRoot\$R6"
    ${EndIf}
  ${Loop}
  FileClose $R3
  Delete "$PayloadRoot\${INSTALL_MANIFEST}"
FunctionEnd

; Moves each entry below $INSTDIR\${BACKUP_DIR}\<rel> back to $INSTDIR\<rel>:
; an entry that is not there moves whole; a folder that is there too is
; merged the same way; a file that is there stays behind (the installed
; version's file wins). Takes <rel> ("" or "x\y\") on the stack. Keeps $0-$2.
Function ${PREFIX}MergeBackLeftovers
  Exch $0
  Push $1
  Push $2
  FindFirst $1 $2 "$INSTDIR\${BACKUP_DIR}\$0*"
  ${DoWhile} $2 != ""
    ${If} $2 != "."
    ${AndIf} $2 != ".."
      ${IfNot} ${FileExists} "$INSTDIR\$0$2"
        Rename "$INSTDIR\${BACKUP_DIR}\$0$2" "$INSTDIR\$0$2"
      ${ElseIf} ${FileExists} "$INSTDIR\${BACKUP_DIR}\$0$2\*.*"
      ${AndIf} ${FileExists} "$INSTDIR\$0$2\*.*"
        Push "$0$2\"
        Call ${PREFIX}MergeBackLeftovers
      ${EndIf}
    ${EndIf}
    FindNext $1 $2
  ${Loop}
  FindClose $1
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Step 6 below: deletes the old version from ${BACKUP_DIR}, but keeps files
; LetAgents did not install. It removes what the old version's manifest lists
; and moves the rest back into $INSTDIR. An old version without a manifest
; (0.1.143 and earlier) is deleted whole only in the default folder, which
; LetAgents owns; in any other folder all of it moves back where the new
; version has no file of the same path, so nothing LetAgents did not install
; is deleted (old files the new version dropped stay too). Uses $R3-$R9.
Function ${PREFIX}DiscardOldVersion
  Delete "$INSTDIR\${BACKUP_DIR}\${MOVED_IN_LIST}"
  StrCpy $PayloadRoot "$INSTDIR\${BACKUP_DIR}"
  Call ${PREFIX}RemoveListedPayload
  ${If} $R9 == "1"
  ${OrIf} $INSTDIR != "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
    Push ""
    Call ${PREFIX}MergeBackLeftovers
  ${EndIf}
  RMDir /r "$INSTDIR\${BACKUP_DIR}"
FunctionEnd
!macroend
!insertmacro DEFINE_REMOVE_LISTED_PAYLOAD ""
!insertmacro DEFINE_REMOVE_LISTED_PAYLOAD "un."

!macro DEFINE_UPDATE_RECOVERY PREFIX
; Renames $MoveFrom\$MoveName to $MoveTo\$MoveName when the source exists.
; Windows can refuse a rename for a moment while a virus scanner reads a file
; that was just written, so it is tried for five seconds. A destination that
; exists is a failure. Adds each failure to $MoveFailures; with
; $MoveStopAtFailure "1", does nothing once there is a failure. Uses $R3.
Function ${PREFIX}MoveLetAgentsEntry
  ${If} $MoveStopAtFailure == "1"
  ${AndIf} $MoveFailures <> 0
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$MoveFrom\$MoveName"
    Return
  ${EndIf}
  ${If} ${FileExists} "$MoveTo\$MoveName"
    DetailPrint "$MoveTo\$MoveName is in the way."
    IntOp $MoveFailures $MoveFailures + 1
    Return
  ${EndIf}
  StrCpy $R3 0
  ${Do}
    ClearErrors
    Rename "$MoveFrom\$MoveName" "$MoveTo\$MoveName"
    ${IfNot} ${Errors}
      Return
    ${EndIf}
    IntOp $R3 $R3 + 1
    ${If} $R3 >= 10
      DetailPrint "Could not move $MoveFrom\$MoveName."
      IntOp $MoveFailures $MoveFailures + 1
      Return
    ${EndIf}
    Sleep 500
  ${Loop}
FunctionEnd

; Deletes $INSTDIR\$MoveName, a file or a folder. Counts a failure when it is
; still there.
Function ${PREFIX}DeleteLetAgentsEntry
  ${If} ${FileExists} "$INSTDIR\$MoveName\*.*"
    RMDir /r "$INSTDIR\$MoveName"
  ${Else}
    Delete "$INSTDIR\$MoveName"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\$MoveName"
    DetailPrint "Could not delete $INSTDIR\$MoveName."
    IntOp $MoveFailures $MoveFailures + 1
  ${EndIf}
FunctionEnd

; Puts the old version back after a swap that was not committed (see the
; table above): deletes the entries ${MOVED_IN_LIST} names from $INSTDIR, then
; moves every old entry back. Both folders stay, so a stop part way leaves a
; state this repeats. Sets $MoveFailures. Uses $R1-$R3, $R5 and $R6.
Function ${PREFIX}RestoreOldVersion
  StrCpy $MoveFailures 0
  StrCpy $MoveStopAtFailure "0"
  ClearErrors
  FileOpen $R5 "$INSTDIR\${BACKUP_DIR}\${MOVED_IN_LIST}" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileRead $R5 $R6
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      StrCpy $R1 $R6 1 -1
      ${If} $R1 == "$\n"
        StrCpy $R6 $R6 -1
      ${EndIf}
      ${If} $R6 != ""
      ${AndIf} $R6 != "."
      ${AndIf} $R6 != ".."
        StrCpy $MoveName $R6
        Call ${PREFIX}DeleteLetAgentsEntry
      ${EndIf}
    ${Loop}
    FileClose $R5
    ${If} $MoveFailures <> 0
      Return
    ${EndIf}
    ; Every new entry is gone: from here no payload entry in $INSTDIR is new.
    Delete "$INSTDIR\${BACKUP_DIR}\${MOVED_IN_LIST}"
    ${If} ${FileExists} "$INSTDIR\${BACKUP_DIR}\${MOVED_IN_LIST}"
      IntOp $MoveFailures $MoveFailures + 1
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $MoveFrom "$INSTDIR\${BACKUP_DIR}"
  StrCpy $MoveTo "$INSTDIR"
  FindFirst $R1 $R2 "$INSTDIR\${BACKUP_DIR}\*"
  ${DoWhile} $R2 != ""
    ${If} $R2 != "."
    ${AndIf} $R2 != ".."
      StrCpy $MoveName $R2
      Call ${PREFIX}MoveLetAgentsEntry
    ${EndIf}
    FindNext $R1 $R2
  ${Loop}
  FindClose $R1
FunctionEnd

; Finishes or undoes an update that stopped part way (see the table above).
; Only in the folder this user's install is registered in. Not
; IsRegisteredInstall: LetAgents.exe itself can be in ${BACKUP_DIR}.
Function ${PREFIX}RecoverInterruptedUpdate
  ReadRegStr $R0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $R0 != $INSTDIR
    Return
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\${STAGE_DIR}\*.*"
  ${AndIf} ${FileExists} "$INSTDIR\${BACKUP_DIR}\*.*"
    Call ${PREFIX}RestoreOldVersion
    ${If} $MoveFailures <> 0
      !insertmacro FAIL_INSTALL "An earlier ${PRODUCT_NAME} update did not finish, and its files in $INSTDIR could not be put back. Close the programs that use them, then try again."
    ${EndIf}
  ${ElseIf} ${FileExists} "$INSTDIR\${BACKUP_DIR}\*.*"
  ${AndIfNot} ${FileExists} "$INSTDIR\${STAGE_DIR}\*.*"
    ; Cases 5 and 6: the new version is in; files the user kept stay.
    Call ${PREFIX}DiscardOldVersion
  ${EndIf}
  ; ${BACKUP_DIR} first: with only ${STAGE_DIR} left, a stop here is case 1.
  RMDir /r "$INSTDIR\${BACKUP_DIR}"
  RMDir /r "$INSTDIR\${STAGE_DIR}"
  ${If} ${FileExists} "$INSTDIR\${BACKUP_DIR}\*.*"
  ${OrIf} ${FileExists} "$INSTDIR\${STAGE_DIR}\*.*"
    !insertmacro FAIL_INSTALL "${PRODUCT_NAME} could not remove the files of an earlier update in $INSTDIR. Close the programs that use them, then try again."
  ${EndIf}
FunctionEnd
!macroend
!insertmacro DEFINE_UPDATE_RECOVERY ""
!insertmacro DEFINE_UPDATE_RECOVERY "un."

!macro MOVE_LETAGENTS_ENTRY NAME
  StrCpy $MoveName "${NAME}"
  Call MoveLetAgentsEntry
!macroend

!macro LIST_LETAGENTS_ENTRY NAME
  FileWrite $R4 "${NAME}$\n"
!macroend

; Steps 2 to 6 above. At the first entry that does not move it stops and
; rolls back (RestoreOldVersion): the new entries go, the old ones come back,
; then both folders go, and the install stops with the old version in place.
; Only for the registered install, as the payload names only LetAgents's own
; entries. Uses $R1-$R6.
Function SwapInStagedPayload
  CreateDirectory "$INSTDIR\${BACKUP_DIR}"
  SetFileAttributes "$INSTDIR\${BACKUP_DIR}" HIDDEN
  StrCpy $MoveStopAtFailure "1"
  StrCpy $MoveFailures 0
  StrCpy $MoveFrom "$INSTDIR"
  StrCpy $MoveTo "$INSTDIR\${BACKUP_DIR}"
  !insertmacro LETAGENTS_PAYLOAD_ENTRIES MOVE_LETAGENTS_ENTRY
  ${If} $MoveFailures = 0
    ClearErrors
    FileOpen $R4 "$INSTDIR\${BACKUP_DIR}\${MOVED_IN_LIST}" w
    ${If} ${Errors}
      IntOp $MoveFailures $MoveFailures + 1
    ${Else}
      !insertmacro LETAGENTS_PAYLOAD_ENTRIES LIST_LETAGENTS_ENTRY
      FileClose $R4
    ${EndIf}
  ${EndIf}
  ${If} $MoveFailures = 0
    StrCpy $MoveFrom "$INSTDIR\${STAGE_DIR}"
    StrCpy $MoveTo "$INSTDIR"
    !insertmacro LETAGENTS_PAYLOAD_ENTRIES MOVE_LETAGENTS_ENTRY
  ${EndIf}
  ${If} $MoveFailures = 0
    ; The commit.
    RMDir "$INSTDIR\${STAGE_DIR}"
    ${IfNot} ${FileExists} "$INSTDIR\${STAGE_DIR}\*.*"
      StrCpy $Staging "0"
      Call DiscardOldVersion
      Return
    ${EndIf}
  ${EndIf}
  Call RestoreOldVersion
  StrCpy $Staging "0"
  ${If} $MoveFailures <> 0
    ; Both folders stay, so the next run puts the old version back.
    StrCpy $RestartAfterFailure "0"
    !insertmacro FAIL_INSTALL "${PRODUCT_NAME} ${VERSION} could not replace the files in $INSTDIR, and could not put all files of the installed version back. Close the programs that use them, then run the installer again."
  ${EndIf}
  RMDir /r "$INSTDIR\${BACKUP_DIR}"
  RMDir /r "$INSTDIR\${STAGE_DIR}"
  !insertmacro FAIL_INSTALL "${PRODUCT_NAME} ${VERSION} could not replace the files in $INSTDIR because some of them are in use. The installed version was not changed. Close the programs that use them, then try again."
FunctionEnd

; Also when a file could not be extracted and the person chose Abort. Then
; only ${STAGE_DIR} exists (case 1); with ${BACKUP_DIR} there too, removing
; ${STAGE_DIR} would turn a swap that was not committed into one that was.
Function .onInstFailed
  ${If} $Staging == "1"
  ${AndIfNot} ${FileExists} "$INSTDIR\${BACKUP_DIR}\*.*"
    SetOutPath "$INSTDIR"
    RMDir /r "$INSTDIR\${STAGE_DIR}"
  ${EndIf}
  ${If} $RestartAfterFailure == "1"
  ${AndIf} $ForceRun == "1"
  ${AndIf} ${FileExists} "$INSTDIR\${EXE_NAME}"
    Exec '"$INSTDIR\${EXE_NAME}"'
  ${EndIf}
FunctionEnd

Function SkipWhenUpdating
  ${If} $Updating == "1"
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  StrCpy $Staging "0"
  StrCpy $RestartAfterFailure "0"
  Call CloseRunningApp
  Call RecoverInterruptedUpdate
  ; An update writes the new version beside the installed one and swaps it in
  ; only when every file is written, so a full disk or a stopped install
  ; leaves the installed version as it was. Only in the folder this user's
  ; LetAgents install is registered in, so files of the same names in any
  ; other folder are never moved or deleted. A first install writes straight
  ; into $INSTDIR. One File /r for both: a second would double the installer.
  Call IsRegisteredInstall
  ${If} $InstalledHere == "1"
    StrCpy $RestartAfterFailure "1"
    StrCpy $Staging "1"
    StrCpy $R0 "$INSTDIR\${STAGE_DIR}"
  ${Else}
    StrCpy $R0 "$INSTDIR"
  ${EndIf}
  SetOutPath "$R0"
  ${If} $Staging == "1"
    SetFileAttributes "$INSTDIR\${STAGE_DIR}" HIDDEN
  ${EndIf}
  ; A file that cannot be written (a full disk) either sets the error flag
  ; (Ignore) or stops the install (Abort, a decompression error), which
  ; ends in .onInstFailed. Both leave the installed version as it was.
  ; The install manifest first, so an install that stops part way can still
  ; be removed exactly.
  ClearErrors
  File "/oname=${INSTALL_MANIFEST}" "${MANIFEST_FILE}"
  File /r "${SOURCE_DIR}\*"
  StrCpy $R1 "0"
  ${If} ${Errors}
    StrCpy $R1 "1"
  ${EndIf}
  ; File /r leaves the working folder in the copy's last subfolder, and
  ; Windows does not move or delete a folder a process works in.
  SetOutPath "$INSTDIR"
  ${If} $R1 == "1"
    ${If} $Staging == "1"
      RMDir /r "$INSTDIR\${STAGE_DIR}"
      StrCpy $Staging "0"
      !insertmacro FAIL_INSTALL "${PRODUCT_NAME} ${VERSION} could not be written to $INSTDIR. The installed version was not changed. Make sure the disk has free space, then try again."
    ${EndIf}
    !insertmacro FAIL_INSTALL "${PRODUCT_NAME} ${VERSION} could not be written to $INSTDIR. Make sure the disk has free space, then try again."
  ${EndIf}
  ${If} $Staging == "1"
    Call SwapInStagedPayload
  ${EndIf}
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

; Removes only what the install wrote, as its install manifest lists it. An
; install without a manifest (0.1.143 and earlier) is removed by its
; top-level entries, folders whole, only in the default folder, which
; LetAgents owns; in any other folder its files stay. Uses $R3-$R9.
Function un.RemoveInstalledPayload
  StrCpy $PayloadRoot "$INSTDIR"
  Call un.RemoveListedPayload
  ${If} $R9 == "0"
  ${AndIf} $INSTDIR == "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
    !insertmacro REMOVE_LETAGENTS_PAYLOAD
  ${EndIf}
FunctionEnd

; User data (%APPDATA%\LetAgents) stays, as it does when the macOS app is
; moved to the Trash.
Section "Uninstall"
  SetShellVarContext current
  Call un.CloseRunningApp
  ; After a stop during an update, LetAgents.exe can be in ${BACKUP_DIR}.
  Call un.RecoverInterruptedUpdate
  Call un.IsRegisteredInstall
  ; An uninstaller in any other folder removes only itself: the shortcuts,
  ; links, Installed apps entry and updater cache belong to the registered
  ; install.
  ${If} $InstalledHere == "1"
    Call un.RemoveInstalledPayload
    Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    DeleteRegKey HKCU "${URL_KEY}"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    RMDir /r "$LOCALAPPDATA\${UPDATER_CACHE}"
  ${EndIf}
  Delete "$INSTDIR\${UNINSTALLER_NAME}"
  RMDir "$INSTDIR"
SectionEnd

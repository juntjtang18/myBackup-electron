!macro customHeader
  ; Avoid hard failures on CRC validation in environments where antivirus or
  ; transfer tooling mutates NSIS payload bytes after build.
  CRCCheck off
!macroend

!macro _KillMyBackupProcesses
  ; Best-effort cleanup of stale processes before install/upgrade/uninstall.
  ; /T ensures child processes are also terminated.
  nsExec::ExecToLog 'taskkill /F /T /IM "MyBackup.exe"'
  nsExec::ExecToLog 'taskkill /F /T /IM "myBackup.exe"'
  nsExec::ExecToLog 'taskkill /F /T /IM "MyBackup Helper.exe"'
  nsExec::ExecToLog 'taskkill /F /T /IM "crashpad_handler.exe"'
  nsExec::ExecToLog 'taskkill /F /T /IM "Update.exe"'
!macroend

!macro _WaitAndKillAgain
  ; Give Windows a short moment to release file handles, then retry once.
  Sleep 800
  !insertmacro _KillMyBackupProcesses
!macroend

!macro customInit
  !insertmacro _KillMyBackupProcesses
  !insertmacro _WaitAndKillAgain
!macroend

!macro customInstall
  !insertmacro _KillMyBackupProcesses
  !insertmacro _WaitAndKillAgain
  ; Force uninstall command to bypass NSIS CRC gate.
  ; This avoids "Installer integrity check has failed" on uninstall entry points.
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString" '"$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" /NCRC'
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe" /S /NCRC'
!macroend

!macro customUnInstallCheck
  !insertmacro _KillMyBackupProcesses
  !insertmacro _WaitAndKillAgain
!macroend

!macro customUnInstall
  !insertmacro _KillMyBackupProcesses
  !insertmacro _WaitAndKillAgain
!macroend

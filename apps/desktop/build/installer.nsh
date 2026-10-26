; Picked up by electron-builder automatically (nsis.include defaults to build/installer.nsh).

!define LEGACY_APP_NAME "AgentMate" ; legacy-name: the app's name before Runova

!macro customUnInstall
  ; Every update runs the previous version's uninstaller with --updated. Terminals are meant
  ; to survive that, so only a real uninstall stops the background terminal host and removes
  ; the copies of it kept outside the install folder (see src/main/ptyHost/hostLauncher.ts).
  ; The running-app check never sees the host, because it only matches the install folder.
  ${ifNot} ${isUpdated}
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$LOCALAPPDATA\${PRODUCT_NAME}\pty-host', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
    Pop $0
    Sleep 500
    RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}\pty-host"
    ; Copies from before the app was renamed live under its old name.
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$LOCALAPPDATA\${LEGACY_APP_NAME}\pty-host', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
    Pop $0
    RMDir /r "$LOCALAPPDATA\${LEGACY_APP_NAME}\pty-host"
    RMDir "$LOCALAPPDATA\${LEGACY_APP_NAME}"
  ${endIf}
!macroend

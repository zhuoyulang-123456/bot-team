; 覆盖升级前先关掉正在运行的旧版本，避免 Bot Team.exe / app.asar 被占用导致覆盖失败
!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "Bot Team.exe"'
  Sleep 800
!macroend

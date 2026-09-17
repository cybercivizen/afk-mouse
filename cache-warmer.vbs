' Double-click to start the cache warmer widget with no console window.
' Stop it from the widget: the x, the tray menu, or Ctrl+Alt+Q.
'
' This is the development launcher — it runs the local Electron. A packaged
' build has its own .exe and does not need this file.
Dim sh, fso, here, electron
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

electron = here & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(electron) Then
  sh.Run """" & electron & """ """ & here & """", 0, False
Else
  MsgBox "Electron is not installed yet. Run: npm install", 48, "Cache Warmer"
End If

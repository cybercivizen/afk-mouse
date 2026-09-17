' Double-click to start the cache warmer widget with no console window.
' Stop it from the widget: the x, or Ctrl+Alt+Q.
Dim sh, fso, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "node """ & here & "\cache-warmer.js""", 0, False

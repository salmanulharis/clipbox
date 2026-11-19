' Starts clipbox-run.cmd without a console window.
Dim shell, dir
Set shell = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd /c """ & dir & "\clipbox-run.cmd""", 0, False

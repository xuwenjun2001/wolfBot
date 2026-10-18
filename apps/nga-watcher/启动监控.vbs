Option Explicit
Dim shell, fso, folder, python, script
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(folder, "watcher.py")
python = "pythonw.exe"
If Not fso.FileExists(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python314\pythonw.exe") Then
  python = "python.exe"
End If
shell.CurrentDirectory = folder
shell.Run """" & python & """ """ & script & """", 1, False

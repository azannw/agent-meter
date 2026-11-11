' Starts Agent Meter with no console window, from anywhere:
'   wscript scripts\start-hidden.vbs            (tray only)
'   wscript scripts\start-hidden.vbs --show     (and open the panel)
' Extra arguments are passed on to the app. If it is already running, the
' running copy handles them (--show opens its panel, --quit closes it).
Option Explicit

Dim fso, shell, appDir, electron, args, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
electron = fso.BuildPath(appDir, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(electron) Then
  WScript.Echo "Agent Meter: Electron not found at " & electron & ". Run npm install in " & appDir & "."
  WScript.Quit 1
End If

args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " """ & WScript.Arguments(i) & """"
Next

shell.CurrentDirectory = appDir
' 0 = hidden window, False = do not wait
shell.Run """" & electron & """ """ & appDir & """" & args, 0, False

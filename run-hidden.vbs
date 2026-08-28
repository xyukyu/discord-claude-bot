' PowerShell スクリプトを完全に不可視で起動するためのランチャー。
'
' 使い方:  wscript.exe run-hidden.vbs [スクリプト名]
'          省略時は guard.ps1
'          例: wscript.exe run-hidden.vbs weekly.ps1
'
' powershell.exe を直接タスクに登録すると -WindowStyle Hidden を付けても
' コンソールウィンドウが一瞬生成されて点滅する。wscript.exe はコンソールを
' 持たないため、そこから window style 0 で起動すると点滅が起きない。
'
' 第3引数 True = 終了を待つ。これによりタスクの実行時間・多重起動抑止
' (MultipleInstances IgnoreNew)・ExecutionTimeLimit が正しく機能し、
' PowerShell の終了コードが LastTaskResult に反映される。

Option Explicit

Dim shell, fso, scriptDir, target, targetPath, cmd, rc

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count > 0 Then
    target = WScript.Arguments(0)
Else
    target = "guard.ps1"
End If

targetPath = fso.BuildPath(scriptDir, target)

If Not fso.FileExists(targetPath) Then
    ' タスクの LastTaskResult に出る形でエラーを返す
    WScript.Quit 2
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & targetPath & """"

rc = shell.Run(cmd, 0, True)

WScript.Quit rc

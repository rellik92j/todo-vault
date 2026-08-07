' Starts the built app with no terminal attached, and nothing left behind.
'
'     wscript.exe scripts\launch.vbs
'
' Every other way of starting this app leaves a console window open for as long
' as the app runs, because every other way puts a process above Electron that
' has to stay alive: `npm run preview` is npm, which waits on electron-vite,
' which waits on Electron. Close the terminal and all three go. That is correct
' behaviour for a dev command and wrong for something you want to double-click
' at the start of the day.
'
' The escape is not a flag, it is a different script host. Windows runs a .vbs
' through wscript.exe by default, and wscript is a GUI-subsystem binary — it
' never allocates a console, so there is no window to close and no parent left
' waiting. (cscript.exe, the same language with a console attached, is what you
' get from `cscript launch.vbs`, and it is exactly what this file exists to
' avoid.) The `0, False` on the Run below is belt and braces: 0 asks for a
' hidden window and False says do not wait, so wscript exits immediately and
' Electron is left running on its own.
'
' Which also means MsgBox is the only way to say anything. Under wscript there
' is no stdout to write to — an error printed here would vanish, and the symptom
' of double-clicking a shortcut would be nothing whatsoever happening. Both
' checks below therefore end in a dialog naming the command that fixes them.
'
' The LF line endings are not an oversight. .gitattributes pins the whole tree to
' eol=lf, which for a .vbs looks like it ought to matter — plenty of Windows
' tooling assumes CRLF — and does not: the Windows Script Host parses this file
' and starts the app either way, which was checked rather than assumed.
'
' What this deliberately does not do is build. It launches whatever is in
' apps/desktop/out, and says so plainly if that is missing. Putting a build in
' front of it would mean a double-click that does nothing visible for about ten
' seconds — measured, on a warm build — with no console to show progress in, and
' minutes rather than seconds on a clone that has never built, where Electron's
' runtime is fetched first. The failure mode is someone clicking again. It would
' also put the build-then-launch sequence in a second place: package.json
' already owns that argument, for `preview`, and one rule enforced in two files
' is one rule too many. The cost is real and worth stating: after a pull that
' touched the desktop app, this launches the old build until `npm run build`.

Option Explicit

Dim fso, shell, repoRoot, appDir, electronExe, mainEntry

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' scripts\launch.vbs -> scripts -> the repo. Derived rather than hardcoded so
' the file survives the repo being cloned somewhere else, which is the whole
' point of it living in the repo instead of in the shortcut.
repoRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
appDir = fso.BuildPath(repoRoot, "apps\desktop")
mainEntry = fso.BuildPath(appDir, "out\main\index.js")

' Electron 43 downloads on first require() rather than on npm install, so this
' path is absent on a clone that has never been built — not on one where
' something went wrong.
electronExe = fso.BuildPath(repoRoot, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(electronExe) Then
    MsgBox "Electron is not installed yet." & vbCrLf & vbCrLf & _
           "Open a terminal in" & vbCrLf & repoRoot & vbCrLf & vbCrLf & _
           "and run:  npm install  then  npm run build" & vbCrLf & vbCrLf & _
           "The first build downloads Electron's runtime (~350 MB). It is " & _
           "cached per machine, so it only happens once.", _
           vbExclamation, "todo-vault"
    WScript.Quit 1
End If

If Not fso.FileExists(mainEntry) Then
    MsgBox "The app has not been built yet." & vbCrLf & vbCrLf & _
           "Open a terminal in" & vbCrLf & repoRoot & vbCrLf & vbCrLf & _
           "and run:  npm run build" & vbCrLf & vbCrLf & _
           "This launcher starts the built app; it does not build it.", _
           vbExclamation, "todo-vault"
    WScript.Quit 1
End If

' The app probes <cwd>/vault when offering the example vault on the Welcome
' screen, so the working directory is part of first-run behaviour rather than
' incidental. A shortcut carries whatever directory Explorer felt like handing
' it, which is why this is set explicitly instead of left to the caller.
shell.CurrentDirectory = repoRoot

' Quoted because both paths contain the user's profile directory and will
' contain a space on any machine whose account name has one.
shell.Run """" & electronExe & """ """ & appDir & """", 0, False

' ---------------------------------------------------------------- update check
'
' Everything below runs with the app already on screen, and that ordering is the
' point rather than an implementation detail. The shortcut exists to open the
' app instantly; a check in front of the launch would spend a `git fetch` of
' silence before the window appeared, and would do it on every launch including
' the ones with nothing to report. So the app starts, wscript stays alive a few
' seconds longer, and a dialog arrives over a running app or not at all.
'
' scripts/check-updates.mts answers in its exit code, because reading a child's
' stdout from VBScript means redirecting to a temp file and then owning the
' cleanup, while Run(..., True) returns the exit code for nothing. 0 is up to
' date; 2, 3 and 4 are the three things worth saying; anything else — including
' the 1 Node exits with after an uncaught exception, and the error raised when
' node is not on PATH at all — means the check could not tell, and the right
' response to that is silence.

Dim tsxCli, checker, verdict, message, command

tsxCli = fso.BuildPath(repoRoot, "node_modules\tsx\dist\cli.mjs")
checker = fso.BuildPath(repoRoot, "scripts\check-updates.mts")

verdict = 0
If fso.FileExists(tsxCli) And fso.FileExists(checker) Then
    ' `node` by bare name, resolved through PATH, and wrapped because Run raises
    ' rather than returning when the executable is not found — a machine with
    ' the repo but no Node on PATH should still get its app, in silence.
    On Error Resume Next
    verdict = shell.Run("node """ & tsxCli & """ """ & checker & """", 0, True)
    If Err.Number <> 0 Then verdict = 0
    On Error GoTo 0
End If

' Every string below is deliberately plain ASCII, and this is the one rule in
' this file that cannot be inferred from reading it. The Windows Script Host
' reads a .vbs through the system ANSI codepage, not as UTF-8, so an em dash
' written here arrives in the dialog as the three characters its UTF-8 bytes
' happen to spell. That was found by reading the rendered dialog back out of the
' window rather than by looking at the source, where it is invisible. Comments
' are exempt because nothing renders them; strings are not.
'
' `npm run build` alone where nothing needs pulling: the two cases that involve
' new commits need the update first, and the one that does not would be spending
' a pull to fix a problem a build already fixes.
If verdict = 2 Then
    message = "The app has changed since it was last built, so this just " & _
              "started the previous version." & vbCrLf & vbCrLf & _
              "Rebuild it now?"
    command = "npm run build"
ElseIf verdict = 3 Then
    message = "A newer version is available." & vbCrLf & vbCrLf & _
              "Update now?"
    command = "npm run update && npm run build"
ElseIf verdict = 4 Then
    message = "A newer version is available, and the app has changed since " & _
              "it was last built, so this just started the previous version." & _
              vbCrLf & vbCrLf & "Update and rebuild now?"
    command = "npm run update && npm run build"
Else
    WScript.Quit 0
End If

message = message & " A terminal will open and run:" & vbCrLf & vbCrLf & _
          "    " & command & vbCrLf & vbCrLf & _
          "The app already running is the old one. Close it and use the " & _
          "shortcut again once this finishes."

If MsgBox(message, vbYesNo + vbQuestion, "todo-vault") = vbYes Then
    ' Visible, and /k so the window stays after it finishes — the one moment in
    ' this whole design where a console is what the user wants, since a build is
    ' the thing worth watching and a failure here needs reading. cmd.exe rather
    ' than PowerShell because `npm` resolves to npm.cmd there and cannot be
    ' stopped by an execution policy, which is the trap scripts/bootstrap.ps1
    ' exists to explain.
    shell.Run "cmd /k cd /d """ & repoRoot & """ && " & command, 1, False
End If

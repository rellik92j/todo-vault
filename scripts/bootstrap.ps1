<#
Gets a brand-new Windows machine from nothing to `npm run menu`, in one run.

    irm https://raw.githubusercontent.com/rellik92j/todo-vault/main/scripts/bootstrap.ps1 | iex

Every other script in this repo can assume Node and a clone already exist.
This one can't assume either — it is the thing that makes them exist — so it
stays a standalone .ps1 with no dependency on npm, tsx, or anything this repo
installs. Each step checks first and skips work already done, so re-running
after a partial failure (a winget prompt dismissed, a flaky clone) does not
redo what already succeeded.

Three rules this file lives by, all of them consequences of being piped to `iex`:

  1. No `exit`, anywhere, not even on success. `iex` runs this text in the
     session's own scope, so there is no script frame for `exit` to unwind to
     and it takes the whole terminal down with it — closing the window on top
     of whatever was just printed. An earlier version ended both of its install
     branches that way, which is how a first run could install Node, print
     careful instructions to reopen the terminal, and vanish before anyone
     could read them. Everything therefore lives inside Invoke-Bootstrap, where
     `return` ends the run and leaves the user at a prompt they can still read.

  2. npm is invoked as `npm.cmd`, never as `npm`. PowerShell resolves the bare
     name to npm.ps1 rather than the npm.cmd sitting beside it, and under
     Restricted — the policy Windows ships to client machines — a .ps1 will not
     load at all. This is the opposite of the call scripts/menu.mts makes, and
     deliberately so: there the constraint is Node's, whose spawn() refuses a
     .cmd shim without shell:true. PowerShell has no such restriction, so here
     the .cmd is the safe one and the bare name is the trap.

  3. Nothing in the user's session is left changed behind their back, with two
     exceptions: the working directory, which is the point — it leaves them in
     the repo — and the execution policy, which is asked about first.
     $ErrorActionPreference is set inside the function rather than at the top of
     the file, so it stops leaking into the shell of whoever ran this.
#>

function Invoke-Bootstrap {
    $ErrorActionPreference = "Stop"

    $RepoUrl = "https://github.com/rellik92j/todo-vault.git"

    # ------------------------------------------------------------------ output

    function Note($text) { Write-Host "==> $text" -ForegroundColor DarkGray }
    function Warn($text) { Write-Host $text -ForegroundColor Yellow }
    function Plain($text) { Write-Host $text -ForegroundColor Gray }

    # Whether there is a human here to answer a question. UserInteractive alone
    # is not enough — it stays true when stdin has been redirected from a file
    # or a pipe, where a prompt has nobody to answer it and ReadKey blocks
    # forever rather than returning. Both have to hold before this script is
    # allowed to stop and ask.
    function Test-CanPrompt {
        return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    }

    <#
    Runs one labelled step and fails loudly if it does not work.

    Never capture this — `Step ...` as a bare statement only. A native command
    writes to the success stream, so the moment a caller wraps a step in
    parentheses to read a result, every line git or npm printed becomes part of
    that result instead of reaching the console. Steps report by throwing.
    #>
    function Step($label, $action) {
        Write-Host "==> $label" -ForegroundColor Cyan
        # $LASTEXITCODE belongs to the user's session here, not to us, and can
        # arrive already set from whatever they ran before this — which would
        # fail a step that had in fact succeeded. Clear it so the test below
        # reads only what $action left behind.
        $global:LASTEXITCODE = 0
        & $action
        if ($LASTEXITCODE -ne 0) {
            throw "$label failed (exit $LASTEXITCODE)"
        }
    }

    # -------------------------------------------------------------------- PATH

    <#
    A process is handed its PATH once, when it starts, so a winget install that
    finishes at 10:00 is invisible to a shell opened at 09:59. That is the only
    reason this script ever asked anyone to open a new terminal and run the
    command a second time — and then a third.

    The registry copy is live, though, and it is what the installers actually
    write; Node and Git both land in the Machine table. Reading it back over
    $env:Path teaches this very process about a tool installed a second ago, and
    the whole round trip disappears.
    #>
    function Update-PathFromRegistry {
        $parts = "Machine", "User" | ForEach-Object {
            [Environment]::GetEnvironmentVariable("Path", $_)
        }
        $env:Path = ($parts | Where-Object { $_ }) -join ";"
    }

    # Refresh, then check. $fallbackDir covers an installer that has put the
    # binary down without recording it on PATH yet; if even that misses, the
    # caller says so plainly rather than letting a later step fail on a
    # "not recognized" that names the wrong problem.
    function Resolve-NewTool($name, $fallbackDir) {
        Update-PathFromRegistry
        if (Get-Command $name -ErrorAction SilentlyContinue) { return $true }
        if ($fallbackDir -and (Test-Path (Join-Path $fallbackDir "$name.exe"))) {
            $env:Path = "$fallbackDir;$env:Path"
            return $true
        }
        return $false
    }

    # -------------------------------------------------------- execution policy

    <#
    The one thing here that changes the user's machine rather than adding to it,
    and the reason it asks rather than assumes.

    PowerShell resolves a bare `npm` to npm.ps1 — a script, not the npm.cmd
    beside it — and under Restricted a script will not load at all. So on a
    fresh box `npm install`, `npm run menu` and every other command in the
    README fail with a security error that names npm.ps1 and explains nothing.

    This script is immune twice over: text piped to `iex` is not a script file,
    and every npm call below goes through npm.cmd. Fixing the policy is
    therefore not about getting *this* run to work — it is about the user's own
    commands working tomorrow, which is exactly the kind of change to ask about
    rather than make quietly.
    #>
    function Confirm-ExecutionPolicy {
        $effective = Get-ExecutionPolicy
        if ($effective -ne "Restricted" -and $effective -ne "AllSigned") { return }

        $fix = "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"

        Write-Host ""
        Warn  "  First, one thing about this machine."
        Write-Host ""
        Plain "  PowerShell's execution policy is '$effective'. Typing 'npm' runs"
        Plain "  npm.ps1, and this policy refuses to load any script, so 'npm run menu'"
        Plain "  and 'npm run dev' will fail for you later with a security error about"
        Plain "  npm.ps1. This bootstrap works around it for its own run. Your commands"
        Plain "  afterwards have no such workaround."
        Write-Host ""

        # Group policy outranks anything -Scope CurrentUser can write, and the
        # set would report success while changing nothing. Say so instead of
        # offering a fix that cannot take.
        $managed = Get-ExecutionPolicy -List | Where-Object {
            ($_.Scope -eq "MachinePolicy" -or $_.Scope -eq "UserPolicy") -and
            $_.ExecutionPolicy -ne "Undefined"
        }
        if ($managed) {
            Plain "  Group policy sets this on your machine, so it cannot be changed per"
            Plain "  user. Use npm.cmd wherever the docs say npm - 'npm.cmd run menu'."
            Write-Host ""
            return
        }

        Plain "  The usual fix is RemoteSigned, for your account only: scripts you write"
        Plain "  yourself run, anything downloaded has to be signed. It needs no"
        Plain "  administrator rights and nothing outside your account changes."
        Write-Host ""

        if (-not (Test-CanPrompt)) {
            Plain "  Nothing was changed - there is no one here to ask. To do it yourself:"
            Plain "      $fix"
            Write-Host ""
            return
        }

        $answer = Read-Host "  Set it to RemoteSigned now? [y/N]"
        if ($answer -match '^\s*y') {
            try {
                Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
                Note "Execution policy set to RemoteSigned for your account"
            } catch {
                # Not fatal: this run does not need it, only the next one does.
                Warn "  Could not change it: $($_.Exception.Message)"
                Plain "  Carrying on. Use npm.cmd in place of npm afterwards."
            }
        } else {
            Plain "  Left alone. To do it later:"
            Plain "      $fix"
            Plain "  Until then use npm.cmd in place of npm - 'npm.cmd run menu'."
        }
        Write-Host ""
    }

    # --------------------------------------------------------------------- git

    # Re-running from inside the clone used to produce todo-vault/todo-vault,
    # because the check was for a subdirectory of that name and there isn't one.
    # Worth guarding now that people have been trained by the old flow to run
    # this command more than once.
    function Test-RepoRoot($dir) {
        $manifest = Join-Path $dir "package.json"
        if (-not (Test-Path $manifest)) { return $false }
        try {
            return (Get-Content $manifest -Raw | ConvertFrom-Json).name -eq "todo-vault-workspace"
        } catch {
            return $false
        }
    }

    # -------------------------------------------------------------------- main

    try {
        Confirm-ExecutionPolicy

        $tools = @(
            @{ Name = "node"; Label = "Node.js"; Package = "OpenJS.NodeJS"; Dir = Join-Path $env:ProgramFiles "nodejs" }
            @{ Name = "git"; Label = "Git"; Package = "Git.Git"; Dir = Join-Path $env:ProgramFiles "Git\cmd" }
        )

        $installed = @()

        foreach ($tool in $tools) {
            if (Get-Command $tool.Name -ErrorAction SilentlyContinue) {
                Note "$($tool.Label) already on PATH, skipping install"
                continue
            }

            if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
                Write-Host ""
                Warn "$($tool.Label) is missing, and winget is not here to install it."
                Plain "  winget ships with Windows 11 and recent Windows 10. Install App"
                Plain "  Installer from the Microsoft Store, or install $($tool.Label) by"
                Plain "  hand, then run this command again."
                Write-Host ""
                return
            }

            # Deliberately not wrapped in Step. winget's exit codes are its own
            # dialect - a package that is installed but absent from PATH comes
            # back as a failure - and the question that actually matters is
            # whether the tool is callable afterwards, which is what gets asked
            # next. Judge the outcome, not the installer's opinion of itself.
            $package = $tool.Package
            Write-Host "==> Install $($tool.Label)" -ForegroundColor Cyan
            winget install -e --id $package --accept-source-agreements --accept-package-agreements

            if (-not (Resolve-NewTool $tool.Name $tool.Dir)) {
                Write-Host ""
                Warn "$($tool.Label) is still not callable from this terminal."
                Plain "  If winget reported an error above, that is the thing to fix. If it"
                Plain "  reported success, the install simply has not reached this window:"
                Plain "  close it, open a new one, and run the same command again."
                Plain "  Everything done so far is kept."
                Write-Host ""
                return
            }

            Note "$($tool.Label) is usable in this terminal now, no restart needed"
            $installed += $tool.Label
        }

        if (Test-RepoRoot (Get-Location).Path) {
            Note "already inside the repo, skipping clone"
        } elseif (Test-Path "todo-vault") {
            Note "./todo-vault already exists, skipping clone"
            Set-Location "todo-vault"
        } else {
            Step "Clone the repo" { git clone $RepoUrl }
            Set-Location "todo-vault"
        }

        $repo = (Get-Location).Path

        Step "Install dependencies" { npm.cmd install }

        $summary = if ($installed) { $installed -join " and " } else { "nothing - both were already here" }

        # Which name the user can actually type afterwards depends on the policy
        # they are left with, whether they took the offer earlier or not. Read
        # the state back rather than remembering what was decided, so a set that
        # failed or was overruled cannot leave a wrong instruction on screen.
        $npm = if ((Get-ExecutionPolicy) -in @("Restricted", "AllSigned")) { "npm.cmd" } else { "npm" }

        Write-Host ""
        Write-Host "  todo-vault is ready." -ForegroundColor Green
        Write-Host ""
        Plain "    Installed this run:  $summary"
        Plain "    Repo:                $repo"
        Plain "    Dependencies:        installed"
        Write-Host ""
        Plain "  To come back to this later, from any terminal:"
        Plain "      cd $repo"
        Plain "      $npm run menu"
        if ($npm -ne "npm") {
            Plain "  (npm.cmd rather than npm: the execution policy above still blocks"
            Plain "  npm.ps1. Setting it to RemoteSigned is what makes plain npm work.)"
        }
        Write-Host ""

        # The menu clears the screen as it starts, so without a pause everything
        # above is gone before it can be read - which was half of what made the
        # old run feel like it might not have worked.
        if (Test-CanPrompt) {
            Write-Host "  Press any key to open the menu..." -ForegroundColor Cyan
            # Even with a console attached, a host can lack RawUI entirely — the
            # ISE is the usual one. Skipping the pause is the right answer there.
            try { [void]$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") } catch { }
            Write-Host ""
        }

        npm.cmd run menu
    } catch {
        Write-Host ""
        Write-Host "Stopped: $($_.Exception.Message)" -ForegroundColor Red
        Plain "Nothing already done is lost. Fix whatever the message above points at"
        Plain "and run the same command again - every step skips work that succeeded."
        Write-Host ""
    }
}

Invoke-Bootstrap

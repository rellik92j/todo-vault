<#
Gets a brand-new Windows machine from nothing to `npm run menu`.

    irm https://raw.githubusercontent.com/rellik92j/todo-vault/main/scripts/bootstrap.ps1 | iex

Every other script in this repo can assume Node and a clone already exist.
This one can't assume either — it is the thing that makes them exist — so it
stays a standalone .ps1 with no dependency on npm, tsx, or anything this repo
installs. Each step checks first and skips work already done, so re-running
after a partial failure (a winget prompt dismissed, a flaky clone) does not
redo what already succeeded.
#>

$ErrorActionPreference = "Stop"

function Step($label, $action) {
    Write-Host "==> $label" -ForegroundColor Cyan
    & $action
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        Write-Host "Failed: $label (exit $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "==> Node already on PATH, skipping install" -ForegroundColor DarkGray
} else {
    Step "Install Node" { winget install -e --id OpenJS.NodeJS --accept-source-agreements --accept-package-agreements }
    Write-Host "Node installed. Close this terminal, open a new one, and re-run this command to continue." -ForegroundColor Yellow
    exit 0
}

if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host "==> Git already on PATH, skipping install" -ForegroundColor DarkGray
} else {
    Step "Install Git" { winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements }
    Write-Host "Git installed. Close this terminal, open a new one, and re-run this command to continue." -ForegroundColor Yellow
    exit 0
}

if (Test-Path "todo-vault") {
    Write-Host "==> ./todo-vault already exists, skipping clone" -ForegroundColor DarkGray
} else {
    Step "Clone the repo" { git clone https://github.com/rellik92j/todo-vault.git }
}

Set-Location todo-vault

Step "Install dependencies" { npm install }

Write-Host "==> Opening the menu" -ForegroundColor Cyan
npm run menu

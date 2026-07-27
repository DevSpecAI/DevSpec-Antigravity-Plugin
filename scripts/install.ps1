<#
  Install the DevSpec skills into Antigravity (Windows / PowerShell).

    ./scripts/install.ps1                      # workspace install -> ./.agents/skills (current dir)
    ./scripts/install.ps1 -Workspace C:\repo   # workspace install -> C:\repo\.agents\skills
    ./scripts/install.ps1 -Global              # global install    -> ~/.gemini/antigravity/skills

  Skills are the *commands*. The MCP connection is configured separately — see README.md.
#>
param(
  [switch]$Global,
  [string]$Workspace = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillsSrc = Join-Path $ScriptDir '..\skills'

if ($Global) {
  # NOTE: confirm this path for your Antigravity version. Workspace installs are most portable.
  $Dest = Join-Path $HOME '.gemini\antigravity\skills'
} else {
  $Dest = Join-Path $Workspace '.agents\skills'
}

Write-Host "Installing DevSpec skills -> $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$count = 0
Get-ChildItem -Directory $SkillsSrc | ForEach-Object {
  $target = Join-Path $Dest $_.Name
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse $_.FullName $target
  Write-Host "  + $($_.Name)"
  $count++
}

Write-Host ""
Write-Host "[OK] Installed $count DevSpec skills into $Dest"
Write-Host ""
Write-Host "Next: connect the DevSpec MCP server (the skills call it):"
Write-Host "  - Antigravity CLI : merge mcp/devspec.mcp.json into ~/.gemini/antigravity-cli/mcp_config.json"
Write-Host "  - Antigravity app : Settings -> MCP -> Add server (type: HTTP, serverUrl + Bearer token)"
Write-Host "  Get your token from DevSpec -> You -> Connections -> Connect a tool (Read & write). Full guide in README.md."

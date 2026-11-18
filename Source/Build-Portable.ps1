param(
    [Parameter(Mandatory=$true)][string]$ElectronRuntime,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'build\AI-Game-Workstation')
)
$ErrorActionPreference='Stop'
$taskRuntime=(Resolve-Path -LiteralPath $ElectronRuntime).Path
$taskOutput=[IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $taskRuntime 'electron.exe'))) { throw 'Electron Windows x64 runtime must contain electron.exe.' }
if ((Test-Path -LiteralPath $taskOutput) -and (Get-ChildItem -LiteralPath $taskOutput -Force | Select-Object -First 1)) { throw 'Output directory is not empty; choose a new output path.' }
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
Get-ChildItem -LiteralPath $taskRuntime | Where-Object Name -ne 'resources' | Copy-Item -Destination $taskOutput -Recurse
$taskApp=Join-Path $taskOutput 'resources\app'
New-Item -ItemType Directory -Path $taskApp -Force | Out-Null
foreach ($taskName in @('main.cjs','preload.cjs','core.cjs','workflow.cjs','ue-tools.cjs','ue-build.cjs','rig-build.cjs','rig_export.py','media.cjs','assistant.cjs','canvas-selftest.cjs','production-selftest.cjs','blender_task.py','package.json','ui')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $taskName) -Destination $taskApp -Recurse
}
Rename-Item -LiteralPath (Join-Path $taskOutput 'electron.exe') -NewName 'AI-Game-Workstation.exe'
Write-Output (Join-Path $taskOutput 'AI-Game-Workstation.exe')

param([Parameter(Mandatory = $true)][string]$ConfigFile)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
if ($config.schema -ne 1 -or (Test-Path -LiteralPath $config.output)) { throw 'Invalid config or output already exists' }
if (-not (Test-Path -LiteralPath $config.profile -PathType Container)) { throw 'Fresh profile directory is missing' }
# Quote according to the Windows C runtime command-line rules, without invoking a shell.
function Quote-NativeArgument([string]$Value) {
  if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
if ($null -ne $config.profileEnv) { [Environment]::SetEnvironmentVariable($config.profileEnv, $config.profile, 'Process') }
[Environment]::SetEnvironmentVariable('TC_BENCH_READY_FILE', $config.readyFile, 'Process')
[Environment]::SetEnvironmentVariable('TC_BENCH_DISABLE_INTEGRATIONS', '1', 'Process')
$clock = [Diagnostics.Stopwatch]::StartNew()
$quoted = @($config.arguments | ForEach-Object { Quote-NativeArgument ([string]$_) })
$startOptions = @{ FilePath = $config.executable; PassThru = $true; WindowStyle = 'Hidden'; WorkingDirectory = (Split-Path -Parent $config.executable) }
if ($quoted.Count -gt 0) { $startOptions.ArgumentList = ($quoted -join ' ') }
$launched = Start-Process @startOptions
$processHandleMs = $clock.Elapsed.TotalMilliseconds
$logical = [Environment]::ProcessorCount
$known = @{}
$known[[string]$launched.Id] = $launched.StartTime.ToUniversalTime()
function Same-CreationTime($First, $Second) { return [Math]::Abs(($First.ToUniversalTime() - $Second.ToUniversalTime()).TotalMilliseconds) -le 1 }
$cpuMax = @{}
$samples = [Collections.Generic.List[object]]::new()
$ready = $null
$previousCpu = $null
$previousAt = $null
$unavailable = [Collections.Generic.List[string]]::new()
$endMs = ($config.settleSeconds + $config.durationSeconds) * 1000
try {
  while ($clock.Elapsed.TotalMilliseconds -lt $endMs) {
    $sampleStart = $clock.Elapsed.TotalMilliseconds
    if ($null -eq $ready -and (Test-Path -LiteralPath $config.readyFile -PathType Leaf)) {
      $ready = @{ observedAtMs = $sampleStart; hostPayload = [IO.File]::ReadAllText($config.readyFile) }
    }
    # Enumerate parent relationships only; inspect metrics only for this launched process tree.
    $inventory = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
    # A bounded breadth-first traversal avoids repeated full scans or PID cycles.
    $children = @{}
    $queue = [Collections.Generic.Queue[object]]::new()
    $visited = [Collections.Generic.HashSet[uint32]]::new()
    foreach ($entry in $inventory) {
      $parentKey = [string]$entry.ParentProcessId
      if (-not $children.ContainsKey($parentKey)) { $children[$parentKey] = [Collections.Generic.List[object]]::new() }
      $children[$parentKey].Add($entry)
      $key = [string]$entry.ProcessId
      if ($known.ContainsKey($key) -and (Same-CreationTime $entry.CreationDate $known[$key])) { $queue.Enqueue($entry) }
    }
    while ($queue.Count -gt 0) {
      $parent = $queue.Dequeue()
      if (-not $visited.Add([uint32]$parent.ProcessId)) { continue }
      $parentKey = [string]$parent.ProcessId
      foreach ($entry in $children[$parentKey]) {
        $key = [string]$entry.ProcessId
        if ($entry.CreationDate.ToUniversalTime() -ge $known[$parentKey]) {
          if (-not $known.ContainsKey($key)) { $known[$key] = $entry.CreationDate.ToUniversalTime() }
          if (Same-CreationTime $entry.CreationDate $known[$key]) { $queue.Enqueue($entry) }
        }
      }
    }
    $processes = [Collections.Generic.List[object]]::new()
    foreach ($entry in $inventory) {
      $key = [string]$entry.ProcessId
      if (-not $known.ContainsKey($key) -or -not (Same-CreationTime $entry.CreationDate $known[$key])) { continue }
      try {
        $owned = Get-Process -Id $entry.ProcessId -ErrorAction Stop
        if (-not (Same-CreationTime $owned.StartTime $known[$key])) { continue }
        $cpu = $owned.TotalProcessorTime.TotalSeconds
        $cpuMax[$key] = [Math]::Max([double]$cpuMax[$key], $cpu)
        $processes.Add(@{ processId = [int]$owned.Id; parentProcessId = [int]$entry.ParentProcessId; cpuSeconds = [double]$cpu; privateBytes = [long]$owned.PrivateMemorySize64; workingSetBytes = [long]$owned.WorkingSet64 })
      } catch { $unavailable.Add("Process $key exited or its metrics were unavailable") }
    }
    $at = $clock.Elapsed.TotalMilliseconds
    $cumulativeCpu = [double](($cpuMax.Values | Measure-Object -Sum).Sum)
    $cpuPercent = $null
    if ($null -ne $previousCpu -and $at -gt $previousAt) { $cpuPercent = 100 * ($cumulativeCpu - $previousCpu) / (($at - $previousAt) / 1000) / $logical }
    $samples.Add(@{ elapsedMs = $at; phase = $(if ($at -lt $config.settleSeconds * 1000) { 'settling' } else { 'sampling' }); observationMs = $at - $sampleStart; logicalProcessorNormalizedCpuPercent = $cpuPercent; cumulativeObservedCpuSeconds = $cumulativeCpu; privateBytes = [long](($processes | ForEach-Object { $_.privateBytes } | Measure-Object -Sum).Sum); aggregateWorkingSetBytes = [long](($processes | ForEach-Object { $_.workingSetBytes } | Measure-Object -Sum).Sum); processes = @($processes.ToArray()) })
    $previousCpu = $cumulativeCpu
    $previousAt = $at
    $remaining = [Math]::Max(1, [int]($config.sampleMs - ($at - $sampleStart)))
    Start-Sleep -Milliseconds $remaining
  }
} finally {
  $result = @{ schema = 1; recordedAtUtc = [DateTime]::UtcNow.ToString('o'); launch = $config; rootProcessId = $launched.Id; launchRequestToProcessHandleMs = $processHandleMs; readySignal = $ready; logicalProcessors = $logical; samples = @($samples.ToArray()); unavailableObservations = @($unavailable.ToArray()); limitations = @('Executable isolation contract is declared by the operator, not verified by the sampler.', 'Launch-to-process-handle is not startup-to-visible-UI.', 'Ready signal semantics, if present, are defined by the measured host.', 'Very short-lived children and children reparented before discovery can be missed.', 'CPU includes observed descendants; terminated process totals retain the last observed value.', 'Working sets may double-count shared pages.', 'Peak memory is a sampled maximum, not an allocation high-water mark.', 'GPU and input latency are not measured.', 'The sampler and CIM queries add overhead.', 'Window visibility/workload is labeled by the operator, not enforced.', 'The launched app is left running; no process or profile cleanup is performed.') }
  $json = $result | ConvertTo-Json -Depth 8
  $stream = [IO.File]::Open($config.output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}

<#
Confere os pré-requisitos locais antes de iniciar demonstração ou prospecção.
O computador hospeda somente o WAHA; o CRM no Vercel executa a Sarah usando
os secrets protegidos no ambiente de produção. Nunca imprime valores de .env.
#>
[CmdletBinding()]
param([string]$WahaEnvPath = '.env.local-waha')

$ErrorActionPreference = 'Stop'

function Get-EnvMap([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Arquivo ausente: $Path"
  }

  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { continue }
    $pair = $line -split '=', 2
    if ($pair.Count -eq 2) {
      # Docker Compose aceita valores entre aspas em env_file; a checagem deve
      # validá-los como o runtime os interpreta, sem imprimir o conteúdo.
      $values[$pair[0].Trim()] = $pair[1].Trim().Trim('"').Trim("'")
    }
  }
  return $values
}

$waha = Get-EnvMap $WahaEnvPath
$invalid = [System.Collections.Generic.List[string]]::new()

if (-not $waha.ContainsKey('WAHA_API_KEY') -or $waha['WAHA_API_KEY'] -notmatch '^sha512:[0-9a-f]{128}$') {
  $invalid.Add("$WahaEnvPath:WAHA_API_KEY")
}

if ($invalid.Count -gt 0) {
  throw "Ambiente local inválido. Corrija sem expor valores: $($invalid -join ', ')"
}

$ping = Invoke-RestMethod -Uri 'http://127.0.0.1:3300/ping' -TimeoutSec 5
if ($null -eq $ping) { throw 'WAHA local não respondeu ao /ping.' }

Write-Output 'Pré-requisitos locais válidos: WAHA local respondeu. O CRM no Vercel executa a Sarah.'

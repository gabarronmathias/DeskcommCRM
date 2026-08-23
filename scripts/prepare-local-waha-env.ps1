<#
Gera o único segredo de que o container WAHA precisa, sem imprimir a chave.
O worker recebe .env.local-worker com a chave plaintext; o WAHA recebe apenas
o hash SHA-512 exigido pelo seu endpoint. Ambos os arquivos são ignorados pelo Git.
#>
param(
  [string]$SourcePath = '.env.local-worker',
  [string]$OutputPath = '.env.local-waha'
)

if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw "Arquivo ausente: $SourcePath. Primeiro obtenha as variáveis de produção da Vercel."
}

$line = Get-Content -LiteralPath $SourcePath |
  Where-Object { $_ -match '^WAHA_API_KEY=' } |
  Select-Object -First 1

if ($null -eq $line) {
  throw 'WAHA_API_KEY não encontrada no arquivo de origem.'
}

$apiKey = $line.Substring('WAHA_API_KEY='.Length)
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'WAHA_API_KEY está vazia no arquivo de origem.'
}

$sha512 = [System.Security.Cryptography.SHA512]::Create()
try {
  $hash = [BitConverter]::ToString($sha512.ComputeHash([Text.Encoding]::UTF8.GetBytes($apiKey))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha512.Dispose()
}

[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) $OutputPath),
  "WAHA_API_KEY=sha512:$hash`n",
  [System.Text.UTF8Encoding]::new($false)
)

Write-Output "Arquivo $OutputPath preparado sem expor a chave."

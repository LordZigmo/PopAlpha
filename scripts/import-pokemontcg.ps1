# ==============================
# PopAlpha PokemonTCG Importer
# ==============================

param(
    [string]$BaseUrl = "https://popalpha.ai/api/admin/import/pokemontcg-canonical",
    [string]$AdminSecret = $env:ADMIN_SECRET
)

$pageStart = 1
$maxPages = 1          # how many pages per invocation (keep 1 for safety)
$pageSize = 50        # 50 max per PokemonTCG API
$retryLimit = 10
$delaySeconds = 2

if ([string]::IsNullOrWhiteSpace($AdminSecret)) {
    Write-Host "ADMIN_SECRET env var or -AdminSecret is required."
    exit 1
}

Write-Host "Starting PokemonTCG canonical import loop..."
Write-Host "---------------------------------------------"

while ($true) {

    $uri = "${BaseUrl}?pageStart=$pageStart&maxPages=$maxPages&pageSize=$pageSize"

    $headers = @{}
    if ($AdminSecret -ne "") {
        $headers["x-admin-secret"] = $AdminSecret
    }

    $attempt = 1
    $success = $false

    while (-not $success -and $attempt -le $retryLimit) {
        try {
            Write-Host "`nCalling pageStart=$pageStart (attempt $attempt)..."
            $response = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -TimeoutSec 120
            $success = $true
        }
        catch {
            Write-Host "Error on attempt ${attempt}: $($_.Exception.Message)"
            if ($attempt -ge $retryLimit) {
                Write-Host "Max retries reached. Exiting."
                exit 1
            }
            Start-Sleep -Seconds 4 ($delaySeconds * $attempt)
            $attempt++
        }
    }

    if (-not $success) {
        Write-Host "Failed to retrieve response. Exiting."
        exit 1
    }

    # Print summary
    Write-Host "Pages processed: $($response.pagesProcessed)"
    Write-Host "Items fetched:   $($response.itemsFetched)"
    Write-Host "Items upserted:  $($response.itemsUpserted)"
    Write-Host "Items failed:    $($response.itemsFailed)"
    Write-Host "Elapsed ms:      $($response.elapsedMs)"
    Write-Host "Done:            $($response.done)"

    if ($response.done -eq $true) {
        Write-Host "`nImport complete."
        break
    }

    $pageStart = $response.nextPageStart

    # Small delay to reduce API pressure
    Start-Sleep -Seconds 1
}

Write-Host "---------------------------------------------"
Write-Host "Finished."

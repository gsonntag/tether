param(
    [object] $WebhookData,
    [ValidateSet('Alert', 'Preview', 'Trip', 'Rearm', 'Boost', 'Expire')]
    [string] $Mode = 'Alert',
    [string] $Deployment,
    [string] $BoostId,
    [int] $Capacity,
    [string] $Until
)

$ErrorActionPreference = 'Stop'
$config = @'
__GUARD_CONFIG__
'@ | ConvertFrom-Json

if ($Mode -eq 'Alert') {
    if (-not $WebhookData) { throw 'An Azure Monitor webhook payload is required.' }
    $alert = $WebhookData.RequestBody | ConvertFrom-Json
    $essentials = $alert.data.essentials
    if ($alert.schemaId -ne 'azureMonitorCommonAlertSchema') { throw 'Unexpected alert schema.' }
    if ($essentials.monitorCondition -ne 'Fired') { return }
    $rule = $config.rules.PSObject.Properties[[string] $essentials.alertRule]
    if (-not $rule -or $config.accountId -notin $essentials.alertTargetIDs) {
        throw 'Alert rule or target is outside the spend guard.'
    }
    $Deployment = $rule.Value
    $Mode = 'Trip'
}

$entry = $config.deployments.PSObject.Properties[$Deployment]
if (-not $entry) { throw 'Unknown deployment.' }
$target = $entry.Value
$expiry = $null
if ($Mode -eq 'Boost') {
    $expiry = [DateTimeOffset]::Parse($Until)
    if ($Capacity -le $target.baseline -or $Capacity -gt $target.maximum -or
        $expiry -le [DateTimeOffset]::UtcNow -or $expiry -gt [DateTimeOffset]::UtcNow.AddHours(1) -or
        $BoostId -notmatch '^[0-9a-f]{32}$') {
        throw 'Invalid or expired boost.'
    }
}

Disable-AzContextAutosave -Scope Process | Out-Null
$context = (Connect-AzAccount -Identity -AllowNoSubscriptions).Context

function Get-BearerToken([string] $Resource) {
    $token = (Get-AzAccessToken -ResourceUrl $Resource -DefaultProfile $context).Token
    if ($token -is [securestring]) {
        return [System.Net.NetworkCredential]::new('', $token).Password
    }
    return $token
}

$managementHeaders = @{ Authorization = "Bearer $(Get-BearerToken 'https://management.azure.com/')" }
$storageHeaders = @{
    Authorization = "Bearer $(Get-BearerToken 'https://storage.azure.com/')"
    'x-ms-version' = '2023-05-03'
}
$deploymentUrl = 'https://management.azure.com' + $target.id + '?api-version=2024-10-01'
$blob = $config.storageUrl + '/' + $Deployment.ToLowerInvariant() + '.json'
$lease = [Guid]::NewGuid().ToString()

function Invoke-GuardRequest {
    param($Method, $Uri, $Headers, $Body, [int[]] $Allow = @())
    $arguments = @{
        Method = $Method; Uri = $Uri; Headers = $Headers
        UseBasicParsing = $true; TimeoutSec = 15; MaximumRedirection = 0
    }
    if ($null -ne $Body) {
        $arguments.Body = $Body
        $arguments.ContentType = 'application/json'
    }
    try {
        return Invoke-WebRequest @arguments
    } catch {
        $response = $_.Exception.Response
        if ($null -eq $response) { throw "$Method request failed for $Uri" }
        $code = [int] $response.StatusCode
        if ($code -notin $Allow) { throw "$Method returned HTTP $code for $Uri" }
        return [PSCustomObject] @{ StatusCode = $code }
    }
}

function Invoke-BlobRequest {
    param($Method, $Suffix = '', $Body, $Headers = @{}, [int[]] $Allow = @())
    $all = $storageHeaders.Clone()
    $all['x-ms-date'] = [DateTime]::UtcNow.ToString('R')
    foreach ($key in $Headers.Keys) { $all[$key] = $Headers[$key] }
    Invoke-GuardRequest -Method $Method -Uri ($blob + $Suffix) -Headers $all -Body $Body -Allow $Allow
}

function Renew-Lease {
    Invoke-BlobRequest -Method PUT -Suffix '?comp=lease' -Body '' -Headers @{
        'x-ms-lease-action' = 'renew'; 'x-ms-lease-id' = $lease
    } | Out-Null
}

function Save-State($State) {
    Invoke-BlobRequest -Method PUT -Body ($State | ConvertTo-Json -Compress) -Headers @{
        'x-ms-blob-type' = 'BlockBlob'; 'x-ms-lease-id' = $lease
    } | Out-Null
}

function Get-Deployment {
    $response = Invoke-GuardRequest -Method GET -Uri $deploymentUrl -Headers $managementHeaders
    $value = $response.Content | ConvertFrom-Json
    if ($value.sku.name -ne 'GlobalStandard' -or $value.properties.model.name -ne $target.model) {
        throw 'Deployment SKU or model has changed.'
    }
    return $value
}

function Wait-Deployment([int] $Expected = 0) {
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    do {
        Renew-Lease
        $value = Get-Deployment
        if ($value.properties.provisioningState -in @('Failed', 'Canceled')) {
            throw 'Deployment provisioning failed.'
        }
        if ($value.properties.provisioningState -eq 'Succeeded' -and
            ($Expected -eq 0 -or $value.sku.capacity -eq $Expected)) {
            return $value
        }
        Start-Sleep -Seconds 5
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Timed out waiting for deployment capacity to settle.'
}

if ($Mode -eq 'Preview') {
    $current = Get-Deployment
    Invoke-BlobRequest -Method GET -Allow @(404) | Out-Null
    Write-Output "$Deployment is at $($current.sku.capacity) SKU units. Trip would cap it at $($target.trip)."
    return
}

$initial = '{"tripped":false,"boost":null}'
Invoke-BlobRequest -Method PUT -Body $initial -Headers @{
    'If-None-Match' = '*'; 'x-ms-blob-type' = 'BlockBlob'
} -Allow @(409, 412) | Out-Null

$deadline = [DateTime]::UtcNow.AddMinutes(3)
do {
    $result = Invoke-BlobRequest -Method PUT -Suffix '?comp=lease' -Body '' -Allow @(409) -Headers @{
        'x-ms-lease-action' = 'acquire'; 'x-ms-lease-duration' = '60'; 'x-ms-proposed-lease-id' = $lease
    }
    if ($result.StatusCode -eq 201) { break }
    Start-Sleep -Seconds 5
} while ([DateTime]::UtcNow -lt $deadline)
if ($result.StatusCode -ne 201) { throw 'Could not acquire the deployment guard lease.' }

try {
    $state = (Invoke-BlobRequest -Method GET -Headers @{ 'x-ms-lease-id' = $lease }).Content | ConvertFrom-Json
    if ($Mode -eq 'Expire' -and $state.boost -ne $BoostId) { return }
    $current = (Wait-Deployment).sku.capacity
    switch ($Mode) {
        'Trip' {
            $state.tripped = $true
            $state.boost = $null
            Save-State $state
            $desired = [Math]::Min($current, $target.trip)
        }
        'Rearm' {
            if ($state.boost) { throw 'An active boost must expire or be tripped before rearming.' }
            $desired = $target.baseline
        }
        'Boost' {
            if ($state.tripped -or $state.boost -or $current -ne $target.baseline -or
                $expiry -le [DateTimeOffset]::UtcNow.AddMinutes(2)) {
                throw 'Boost needs a rearmed deployment at baseline and at least two minutes remaining.'
            }
            $state.boost = $BoostId
            Save-State $state
            $desired = $Capacity
        }
        'Expire' {
            $desired = [Math]::Min($current, $target.baseline)
        }
    }
    if ($current -ne $desired) {
        Renew-Lease
        $body = @{ sku = @{ name = 'GlobalStandard'; capacity = $desired } } | ConvertTo-Json -Compress
        Invoke-GuardRequest -Method PATCH -Uri $deploymentUrl -Headers $managementHeaders -Body $body | Out-Null
        Wait-Deployment -Expected $desired | Out-Null
    }
    if ($Mode -in @('Expire', 'Rearm')) {
        $state.boost = $null
        $state.tripped = $false
        Save-State $state
    }
    Write-Output "$Mode applied to $Deployment at $desired SKU units."
} finally {
    Invoke-BlobRequest -Method PUT -Suffix '?comp=lease' -Body '' -Headers @{
        'x-ms-lease-action' = 'release'; 'x-ms-lease-id' = $lease
    } -Allow @(409, 412) | Out-Null
}

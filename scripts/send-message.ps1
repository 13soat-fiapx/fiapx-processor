param (
  [string]$ProcessingJobId = '8f160f70-b26b-4eb2-8ff9-c69b4f8d2e0e',
  [string]$VideoPath = ''
)

$UserId    = 'auth0|abc123'
$UserName  = 'Local User'
$UserEmail = 'local.user@fiapx.io'
$QueueName = 'fiapx-dev-video-processing-requested'
$TableName = 'fiapx-dev-videos-db'
$Container = 'video-processor-localstack-1'
$Bucket    = 'fiapx-dev-artifacts-000000000000'
$InputKey  = "videos/$ProcessingJobId/original.mp4"

$occurredAt = (Get-Date).ToUniversalTime().ToString('s')
$eventId    = [System.Guid]::NewGuid().ToString()
$traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-519aa4f8279bde01-01'

$messageHeaders = @{
  eventId      = $eventId
  eventType    = 'VideoProcessingRequested'
  eventVersion = '1.0'
  traceparent  = $traceparent
  occurredAt   = $occurredAt
  source       = 'fiapx-api'
}

$messagePayload = @{
  processingJobId  = $ProcessingJobId
  userId           = $UserId
  outputPrefix     = "frames/$ProcessingJobId/"
  requestedAt      = $occurredAt
  inputFile        = @{
    bucket           = $Bucket
    key              = $InputKey
    region           = 'us-east-1'
    originalFileName = 'original.mp4'
    contentType      = 'video/mp4'
    sizeBytes        = 10485760
  }
}

if ($VideoPath)
{
  if (!(Test-Path -LiteralPath $VideoPath))
  {
    throw "Video file not found: $VideoPath"
  }

  Write-Host -ForegroundColor Yellow "Uploading input video to s3://$Bucket/$InputKey..."

  $ContainerVideoPath = "/tmp/$ProcessingJobId-original.mp4"

  docker cp $VideoPath "${Container}:$ContainerVideoPath"

  if ($LASTEXITCODE -ne 0)
  {
    throw "Failed to copy '$VideoPath' into LocalStack container"
  }

  docker exec $Container `
    awslocal s3 cp "$ContainerVideoPath" "s3://$Bucket/$InputKey" `
      --content-type 'video/mp4'

  if ($LASTEXITCODE -ne 0)
  {
    throw "Failed to upload '$VideoPath' to s3://$Bucket/$InputKey"
  }

  docker exec $Container rm -f "$ContainerVideoPath" > $null
}

$jobItem = @{
  id                 = @{ S = $ProcessingJobId }
  userId             = @{ S = $UserId }
  userName           = @{ S = $UserName }
  userEmail          = @{ S = $UserEmail }
  status             = @{ S = 'queued' }
  inputFile          = @{
    M = @{
      s3Object        = @{
        M = @{
          bucket      = @{ S = $Bucket }
          key         = @{ S = $InputKey }
          region      = @{ S = 'us-east-1' }
        }
      }
      originalFileName = @{ S = 'original.mp4' }
      contentType      = @{ S = 'video/mp4' }
      sizeBytes        = @{ N = '10485760' }
    }
  }
  outputPrefix       = @{ S = "frames/$ProcessingJobId/" }
  progressPercentage = @{ N = '0' }
  createdAt          = @{ S = $occurredAt }
  updatedAt          = @{ S = $occurredAt }
  messages           = @{
    L = @(
      @{
        M = @{
          code      = @{ S = 'PROC-0002' }
          message   = @{ S = 'Upload confirmed and processing job queued.' }
          severity  = @{ S = 'info' }
          createdAt = @{ S = $occurredAt }
        }
      }
    )
  }
} | ConvertTo-Json -Depth 20 -Compress

Write-Host -ForegroundColor Yellow "Seeding DynamoDB job '$ProcessingJobId'..."

$JobPath = [System.IO.Path]::GetTempFileName()
$ContainerJobPath = "/tmp/$ProcessingJobId-job.json"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($JobPath, $jobItem, $Utf8NoBom)

docker cp $JobPath "${Container}:$ContainerJobPath"

if ($LASTEXITCODE -ne 0)
{
  Remove-Item -LiteralPath $JobPath -Force
  throw "Failed to copy DynamoDB job item into LocalStack container"
}

docker exec $Container `
  awslocal dynamodb put-item `
    --table-name "$TableName" `
    --item "file://$ContainerJobPath"

$PutExitCode = $LASTEXITCODE
docker exec $Container rm -f "$ContainerJobPath" > $null
Remove-Item -LiteralPath $JobPath -Force

if ($PutExitCode -ne 0)
{
  throw "Failed to seed job '$ProcessingJobId' in table '$TableName'"
}

$body = @{
  headers = $messageHeaders
  payload = $messagePayload
} | ConvertTo-Json -Depth 10 -Compress

Write-Host -ForegroundColor Yellow "Publishing VideoProcessingRequested ($ProcessingJobId)..."

$MessagePath = [System.IO.Path]::GetTempFileName()
$ContainerMessagePath = "/tmp/$ProcessingJobId-message.json"

[System.IO.File]::WriteAllText($MessagePath, $body, $Utf8NoBom)

docker cp $MessagePath "${Container}:$ContainerMessagePath"

if ($LASTEXITCODE -ne 0)
{
  Remove-Item -LiteralPath $MessagePath -Force
  throw "Failed to copy SQS message body into LocalStack container"
}

docker exec $Container `
  awslocal sqs send-message `
    --queue-url "http://localhost:4566/000000000000/$QueueName" `
    --message-body "file://$ContainerMessagePath"

$SendExitCode = $LASTEXITCODE
docker exec $Container rm -f "$ContainerMessagePath" > $null
Remove-Item -LiteralPath $MessagePath -Force

if ($SendExitCode -ne 0)
{
  throw "Failed to send message to '$QueueName'"
}

Write-Host -ForegroundColor Green "Message published successfully (eventId: $eventId)."

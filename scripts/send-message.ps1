param (
  [string]$ProcessingJobId = '8f160f70-b26b-4eb2-8ff9-c69b4f8d2e0e',
  [string]$VideoPath = ''
)

$UserId    = 'auth0|abc123'
$QueueName = 'fiapx-dev-video-processing-requested'
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

$body = @{
  headers = $messageHeaders
  payload = $messagePayload
} | ConvertTo-Json -Depth 10 -Compress

Write-Host -ForegroundColor Yellow "Publishing VideoProcessingRequested ($ProcessingJobId)..."

$MessagePath = [System.IO.Path]::GetTempFileName()
$ContainerMessagePath = "/tmp/$ProcessingJobId-message.json"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
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

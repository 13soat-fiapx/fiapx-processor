param (
  [string]$ProcessingJobId = '8f160f70-b26b-4eb2-8ff9-c69b4f8d2e0e'
)

$UserId    = 'auth0|abc123'
$QueueName = 'fiapx-dev-video-processing-requested'
$Container = 'video-processor-localstack-1'
$Bucket    = 'fiapx-dev-videos'

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
    key              = "videos/$ProcessingJobId/original.mp4"
    region           = 'us-east-1'
    originalFileName = 'original.mp4'
    contentType      = 'video/mp4'
    sizeBytes        = 10485760
  }
}

$body = @{
  headers = $messageHeaders
  payload = $messagePayload
} | ConvertTo-Json -Depth 10 -Compress

Write-Host -ForegroundColor Yellow "Publishing VideoProcessingRequested ($ProcessingJobId)..."

docker exec $Container `
    awslocal sqs send-message `
        --queue-url "http://localhost:4566/000000000000/$QueueName" `
        --message-body $body

if ($LASTEXITCODE -ne 0)
{
  throw "Failed to send message to '$QueueName'"
}

Write-Host -ForegroundColor Green "Message published successfully (eventId: $eventId)."

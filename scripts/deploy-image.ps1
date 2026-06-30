param (
  [Parameter(HelpMessage = "Environment for deploy: dev, stg, prod")]
  [ValidateSet("dev", "stg", "prod")]
  [string]$Environment = "dev"
)

$serviceName = 'processor'
$namespace   = 'processing'
$queueName   = 'video-processing-requested'

Write-Host "Fetching data for environment '$Environment'..."
$accountId     = aws sts get-caller-identity --query Account --output text
$repositoryUrl = "$accountId.dkr.ecr.us-east-1.amazonaws.com/fiapx-$Environment/$serviceName-cr"
$queueUrl      = "https://sqs.us-east-1.amazonaws.com/$accountId/fiapx-$Environment-$queueName"
$tag           = (New-Guid).Guid

$password = aws ecr get-login-password --region us-east-1
docker login --username AWS --password $password $repositoryUrl

Write-Host -ForegroundColor Yellow "Building and pushing image with tag '$tag'..."
docker build -t $serviceName -t "$($repositoryUrl):$tag" -t "$($repositoryUrl):latest" .
docker push "$($repositoryUrl):$tag"
docker push "$($repositoryUrl):latest"

Write-Host -ForegroundColor Yellow "Deploying application..."
helm upgrade --install $serviceName ./k8s `
    --namespace $namespace `
    --create-namespace `
    --set image.repository=$repositoryUrl `
    --set image.tag="$tag" `
    --set app.name=$serviceName `
    --set app.env=$Environment `
    --set queue.name=$queueName `
    --set queue.url=$queueUrl

Write-Host -ForegroundColor Green "Done."

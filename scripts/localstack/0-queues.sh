#!/bin/bash

QUEUES=(
  'fiapx-dev-video-processing-requested'
  'fiapx-dev-video-processing-completed'
)

for QUEUE in "${QUEUES[@]}"; do
  awslocal sqs create-queue --queue-name "$QUEUE" > /dev/null
  echo "Queue '$QUEUE' created."
done

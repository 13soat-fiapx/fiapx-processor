#!/bin/bash

BUCKETS=(
  'fiapx-dev-videos'
)

for BUCKET in "${BUCKETS[@]}"; do
  awslocal s3 mb "s3://$BUCKET" > /dev/null
  echo "Bucket '$BUCKET' created."
done

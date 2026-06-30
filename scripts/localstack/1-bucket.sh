#!/bin/bash

BUCKETS=(
  'fiapx-dev-artifacts-000000000000'
)

for BUCKET in "${BUCKETS[@]}"; do
  awslocal s3 mb "s3://$BUCKET" > /dev/null
  echo "Bucket '$BUCKET' created."
done

#!/bin/bash

TABLE="fiapx-dev-videos-db"

awslocal dynamodb create-table \
  --table-name "$TABLE" \
  --attribute-definitions \
    AttributeName=id,AttributeType=S \
    AttributeName=userId,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --global-secondary-indexes '[
    {
      "IndexName": "userId-index",
      "KeySchema": [
        {"AttributeName": "userId", "KeyType": "HASH"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    }
  ]' \
  --billing-mode PAY_PER_REQUEST > /dev/null

echo "Table '${TABLE}' created."

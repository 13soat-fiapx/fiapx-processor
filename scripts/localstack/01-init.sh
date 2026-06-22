#!/usr/bin/env bash
set -euo pipefail

awslocal sqs create-queue --queue-name video-processing
awslocal s3 mb s3://videos
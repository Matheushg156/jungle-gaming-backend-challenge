#!/bin/sh
set -eu
awslocal sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true,ContentBasedDeduplication=false
DLQ_URL=$(awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true,ContentBasedDeduplication=false --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
python3 - "$DLQ_ARN" <<'PY'
import json, sys
attributes = {
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "VisibilityTimeout": "60",
    "RedrivePolicy": json.dumps({"deadLetterTargetArn": sys.argv[1], "maxReceiveCount": "5"}),
}
with open('/tmp/jungle-input-attributes.json', 'w') as output:
    json.dump(attributes, output)
PY
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes file:///tmp/jungle-input-attributes.json

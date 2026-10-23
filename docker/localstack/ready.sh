#!/bin/sh
set -eu
awslocal sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true,ContentBasedDeduplication=false

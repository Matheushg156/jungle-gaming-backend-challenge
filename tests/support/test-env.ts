// Integration tests opt into scheduled workers explicitly.
process.env.REFERENCE_RECOVERY_ENABLED = 'false';
process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
process.env.SQS_CONSUMER_ENABLED = 'false';

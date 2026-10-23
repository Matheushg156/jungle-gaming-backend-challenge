import { connectDatabase } from '../../src/infrastructure/persistence/database';
import { PostgresOutboxRepository } from '../../src/infrastructure/persistence/repositories/postgres-outbox.repository';
import { PublishOutbox } from '../../src/application/events/publish-outbox';
import {
  createLocalSqsClient,
  SqsEventPublisher,
} from '../../src/infrastructure/messaging/sqs-event.publisher';

async function run() {
  const orm = await connectDatabase(process.env.WAGER_TEST_DATABASE_URL);
  const client = createLocalSqsClient(process.env.TEST_SQS_ENDPOINT);
  try {
    const publisher = new SqsEventPublisher(
      client,
      process.env.TEST_EVENTS_QUEUE_URL!,
    );
    process.stdout.write('READY\n');
    // The financial transaction was committed by the parent. Kill this process
    // at this barrier to prove another publisher can recover its pending events.
    await Bun.stdin.text();
    const result = await new PublishOutbox(
      new PostgresOutboxRepository(orm),
      publisher,
    ).execute();
    process.stdout.write(`PUBLISHED:${result.published}\n`);
  } finally {
    client.destroy();
    await orm.close(true);
  }
}
run().catch(() => {
  console.error('Publisher process failed');
  process.exitCode = 1;
});

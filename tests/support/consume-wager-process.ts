import { SubmitWager } from '../../src/application/wagering/submit-wager';
import type { SubmitWagerInput } from '../../src/application/wagering/wager.contracts';
import type { WagerSubmissionContext } from '../../src/application/ports/wagering-unit-of-work';
import { connectDatabase } from '../../src/infrastructure/persistence/database';
import { PostgresWageringUnitOfWork } from '../../src/infrastructure/persistence/repositories/postgres-wagering-unit-of-work';
import { createLocalSqsClient } from '../../src/infrastructure/messaging/sqs-event.publisher';
import { WagerQueueConsumer } from '../../src/infrastructure/messaging/wager-queue.consumer';

class PauseAfterCommit extends SubmitWager {
  override async execute(
    input: SubmitWagerInput,
    key: string,
    context?: WagerSubmissionContext,
  ) {
    const result = await super.execute(input, key, context);
    process.stdout.write('COMMITTED\n');
    await Bun.stdin.text();
    return result;
  }
}

async function run() {
  const orm = await connectDatabase(process.env.WAGER_TEST_DATABASE_URL);
  const client = createLocalSqsClient(process.env.TEST_SQS_ENDPOINT);
  try {
    const Submit =
      process.env.PAUSE_AFTER_COMMIT === 'true'
        ? PauseAfterCommit
        : SubmitWager;
    const consumer = new WagerQueueConsumer(
      client,
      process.env.TEST_INPUT_QUEUE_URL!,
      process.env.TEST_DLQ_URL!,
      new Submit(new PostgresWageringUnitOfWork(orm)),
      { waitTimeSeconds: 0, visibilitySeconds: 1 },
    );
    process.stdout.write('READY\n');
    if (process.env.PAUSE_AFTER_COMMIT === 'true') {
      await consumer.processNext();
    } else {
      const count = Number(await Bun.stdin.text());
      let consumed = 0;
      for (let attempt = 0; attempt < 500 && consumed < count; attempt++) {
        const result = await consumer.processNext();
        if (result.outcome === 'ACKNOWLEDGED') {
          consumed++;
        } else if (result.outcome !== 'EMPTY') {
          throw new Error('Unexpected consumption result');
        } else {
          await Bun.sleep(20);
        }
      }
      if (consumed !== count) {
        throw new Error('Consumer did not receive expected deliveries');
      }
      process.stdout.write(`CONSUMED:${consumed}\n`);
    }
  } finally {
    client.destroy();
    await orm.close(true);
  }
}

run().catch(() => {
  console.error('Consumer process failed');
  process.exitCode = 1;
});

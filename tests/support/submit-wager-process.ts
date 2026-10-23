import { connectDatabase } from '../../src/infrastructure/persistence/database';
import { PostgresWageringUnitOfWork } from '../../src/infrastructure/persistence/repositories/postgres-wagering-unit-of-work';
import { SubmitWager } from '../../src/application/wagering/submit-wager';
import type { SubmitWagerInput } from '../../src/application/wagering/wager.contracts';

async function run(): Promise<void> {
  const orm = await connectDatabase(process.env.WAGER_TEST_DATABASE_URL);
  try {
    const submit = new SubmitWager(new PostgresWageringUnitOfWork(orm));
    process.stdout.write('READY\n');
    // Trusted fixture protocol: the parent sends typed inputs only after all children are ready.
    const requests = JSON.parse(await Bun.stdin.text()) as {
      input: SubmitWagerInput;
      key: string;
    }[];
    const results = await Promise.all(
      requests.map(({ input, key }) => submit.execute(input, key)),
    );
    process.stdout.write(JSON.stringify(results));
  } finally {
    await orm.close(true);
  }
}

run().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Child process failed',
  );
  process.exitCode = 1;
});

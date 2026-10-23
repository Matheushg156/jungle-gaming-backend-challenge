import { connectDatabase } from './database';

async function migrate(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('Expected migration direction: up or down');
  }

  const orm = await connectDatabase();
  try {
    const migrations = await orm.getMigrator()[direction]();
    console.log(`${migrations.length} migration(s) applied: ${direction}`);
  } finally {
    await orm.close();
  }
}

migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
});

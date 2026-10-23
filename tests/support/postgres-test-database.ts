import { randomUUID } from 'node:crypto';
import { connectDatabase } from '../../src/infrastructure/persistence/database';

export async function createTestDatabase() {
  const configuredUrl = process.env.TEST_DATABASE_URL;
  if (!configuredUrl || !new URL(configuredUrl).pathname.endsWith('_test')) {
    throw new Error(
      'TEST_DATABASE_URL must point to a dedicated database ending in _test',
    );
  }

  const databaseName = `jungle_test_${randomUUID().replaceAll('-', '')}`;
  const admin = await connectDatabase(configuredUrl);
  const url = new URL(configuredUrl);
  url.pathname = `/${databaseName}`;

  try {
    await admin.em.execute(`create database "${databaseName}"`);
    const orm = await connectDatabase(url.toString());
    try {
      await orm.getMigrator().up();
    } catch (error: unknown) {
      await orm.close(true);
      throw error;
    }

    return {
      orm,
      url: url.toString(),
      async close(): Promise<void> {
        try {
          await orm.close(true);
        } finally {
          try {
            await admin.em.execute(
              `drop database "${databaseName}" with (force)`,
            );
          } finally {
            await admin.close(true);
          }
        }
      },
    };
  } catch (error: unknown) {
    try {
      await admin.em.execute(
        `drop database if exists "${databaseName}" with (force)`,
      );
    } finally {
      await admin.close(true);
    }
    throw error;
  }
}

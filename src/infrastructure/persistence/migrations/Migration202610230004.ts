import { Migration } from '@mikro-orm/migrations';

export class Migration202610230004 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wallet_ledger_entries add column sequence_number bigint generated always as identity;
      create unique index ledger_wallet_sequence on wallet_ledger_entries(wallet_id, sequence_number);
    `);
  }

  override down(): void {
    this.addSql(`
      drop index ledger_wallet_sequence;
      alter table wallet_ledger_entries drop column sequence_number;
    `);
  }
}

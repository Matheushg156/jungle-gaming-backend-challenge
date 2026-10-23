import { Migration } from '@mikro-orm/migrations';

export class Migration202610230001 extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null check (currency in ('BRL', 'USD', 'EUR')),
        balance numeric(18,2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        unique (player_id, currency),
        unique (id, player_id, currency)
      );

      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(255) not null,
        external_transaction_id varchar(255) not null,
        idempotency_key varchar(255) not null unique,
        payload_hash varchar(255) not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id varchar(255) not null,
        game_id varchar(255) not null,
        kind varchar(20) not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(18,2) not null,
        currency varchar(3) not null,
        status varchar(30) not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid references wager_transactions(id),
        failure_code varchar(255),
        created_at timestamptz not null,
        processed_at timestamptz,
        unique (provider_id, external_transaction_id),
        unique (id, wallet_id, currency),
        foreign key (wallet_id, player_id, currency) references wallets(id, player_id, currency),
        check ((kind = 'LOSS' and amount = 0) or (kind <> 'LOSS' and amount > 0)),
        check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        check (status <> 'PROCESSED' or processed_at is not null),
        check (status not in ('REJECTED', 'FAILED') or failure_code is not null)
      );
      create unique index one_reversal_per_kind on wager_transactions(reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');

      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction varchar(6) not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(18,2) not null check (amount > 0),
        currency varchar(3) not null,
        balance_before numeric(18,2) not null check (balance_before >= 0),
        balance_after numeric(18,2) not null check (balance_after >= 0),
        created_at timestamptz not null,
        unique (wallet_id, transaction_id),
        foreign key (transaction_id, wallet_id, currency) references wager_transactions(id, wallet_id, currency),
        check (balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end)
      );
      create index ledger_wallet_cursor on wallet_ledger_entries(wallet_id, created_at, id);

      create function reject_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'Ledger entries are immutable' using errcode = '23514';
      end $$;
      create trigger immutable_ledger before update or delete on wallet_ledger_entries
        for each row execute function reject_ledger_mutation();
      create trigger immutable_ledger_truncate before truncate on wallet_ledger_entries
        for each statement execute function reject_ledger_mutation();

      create function check_wallet_ledger_balance() returns trigger language plpgsql as $$
      declare
        target_wallet uuid;
        stored numeric;
        calculated numeric;
      begin
        if TG_TABLE_NAME = 'wallets' then target_wallet := NEW.id;
        else target_wallet := NEW.wallet_id;
        end if;

        select balance into stored from wallets where id = target_wallet for update;
        select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)
          into calculated from wallet_ledger_entries where wallet_id = target_wallet;
        if stored <> calculated then
          raise exception 'Wallet balance does not match ledger' using errcode = '23514';
        end if;
        return null;
      end $$;
      create constraint trigger wallet_balance_matches_ledger after insert or update on wallets
        deferrable initially deferred for each row execute function check_wallet_ledger_balance();
      create constraint trigger ledger_matches_wallet_balance after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function check_wallet_ledger_balance();
    `);
  }

  override down(): void {
    this.addSql(`
      drop table wallet_ledger_entries;
      drop function reject_ledger_mutation();
      drop table wager_transactions;
      drop table wallets;
      drop function check_wallet_ledger_balance();
    `);
  }
}

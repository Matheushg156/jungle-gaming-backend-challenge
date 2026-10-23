import { Migration } from '@mikro-orm/migrations';

export class Migration202610230002 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions add column result jsonb;

      -- Rejected requests retain the supplied player and currency for audit.
      -- Only processed requests must match the wallet identity.
      alter table wager_transactions drop constraint wager_transactions_wallet_id_player_id_currency_fkey;
      alter table wager_transactions add constraint wager_wallet_fk foreign key (wallet_id) references wallets(id);
      alter table wager_transactions add constraint processed_reversal_has_reference
        check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null);

      create function prevent_terminal_wager_changes() returns trigger language plpgsql as $$
      begin
        if OLD.status in ('PROCESSED', 'REJECTED', 'FAILED') and OLD is distinct from NEW then
          raise exception 'Terminal transaction is immutable' using errcode = '23514';
        end if;
        return NEW;
      end $$;
      create trigger immutable_terminal_wager before update on wager_transactions
        for each row execute function prevent_terminal_wager_changes();

      create function check_wager_ledger() returns trigger language plpgsql as $$
      declare
        target_id uuid;
        wager wager_transactions%rowtype;
        entry wallet_ledger_entries%rowtype;
        wallet wallets%rowtype;
        expected_direction varchar(6);
      begin
        if TG_TABLE_NAME = 'wager_transactions' then target_id := NEW.id;
        else target_id := NEW.transaction_id;
        end if;
        select * into wager from wager_transactions where id = target_id;
        select * into entry from wallet_ledger_entries where transaction_id = target_id and wallet_id = wager.wallet_id;

        if wager.status = 'PROCESSED' then
          select * into wallet from wallets where id = wager.wallet_id;
          if wallet.player_id <> wager.player_id or wallet.currency <> wager.currency then
            raise exception 'Processed wager does not match wallet identity' using errcode = '23514';
          end if;
        end if;

        if wager.status <> 'PROCESSED' or wager.kind = 'LOSS' then
          if entry.id is not null then
            raise exception 'Non-financial transaction cannot have ledger entry' using errcode = '23514';
          end if;
        else
          expected_direction := case when wager.kind = 'BET' then 'DEBIT' else 'CREDIT' end;
          if wager.kind = 'ROLLBACK' then
            select case when kind = 'BET' then 'CREDIT' else 'DEBIT' end into expected_direction
              from wager_transactions where id = wager.reference_transaction_id;
          end if;
          if entry.id is null or entry.amount <> wager.amount or entry.direction <> expected_direction then
            raise exception 'Processed financial transaction must have matching ledger entry' using errcode = '23514';
          end if;
        end if;
        return null;
      end $$;
      create constraint trigger wager_matches_ledger after insert or update on wager_transactions
        deferrable initially deferred for each row execute function check_wager_ledger();
      create constraint trigger ledger_matches_wager after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function check_wager_ledger();
    `);
  }

  override down(): void {
    this.addSql(`
      drop trigger ledger_matches_wager on wallet_ledger_entries;
      drop trigger wager_matches_ledger on wager_transactions;
      drop function check_wager_ledger();
      drop trigger immutable_terminal_wager on wager_transactions;
      drop function prevent_terminal_wager_changes();
      alter table wager_transactions drop constraint processed_reversal_has_reference;
      alter table wager_transactions drop constraint wager_wallet_fk;
      alter table wager_transactions add foreign key (wallet_id, player_id, currency) references wallets(id, player_id, currency) not valid;
      alter table wager_transactions drop column result;
    `);
  }
}

import { Migration } from '@mikro-orm/migrations';

export class Migration202610230003 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column reference_attempts integer not null default 0 check (reference_attempts >= 0),
        add column next_reference_attempt_at timestamptz,
        add column reference_expires_at timestamptz;

      update wager_transactions set next_reference_attempt_at = created_at + interval '1 second',
        reference_expires_at = created_at + interval '24 hours' where status = 'PENDING_REFERENCE';
      alter table wager_transactions add constraint pending_reference_is_scheduled
        check (status <> 'PENDING_REFERENCE' or (next_reference_attempt_at is not null and reference_expires_at is not null));
      create index due_pending_references on wager_transactions(next_reference_attempt_at, id)
        where status = 'PENDING_REFERENCE';

      create function check_processed_wager_reference() returns trigger language plpgsql as $$
      declare ref wager_transactions%rowtype;
      begin
        if NEW.status <> 'PROCESSED' then return NEW; end if;
        if NEW.reference_external_transaction_id is null and NEW.kind not in ('REFUND', 'ROLLBACK') then return NEW; end if;
        select * into ref from wager_transactions where id = NEW.reference_transaction_id;
        if ref.id is null or ref.id = NEW.id or ref.status <> 'PROCESSED' or
          ref.provider_id <> NEW.provider_id or ref.player_id <> NEW.player_id or
          ref.wallet_id <> NEW.wallet_id or ref.currency <> NEW.currency or ref.round_id <> NEW.round_id or
          ref.external_transaction_id <> NEW.reference_external_transaction_id then
          raise exception 'Processed transaction has invalid reference' using errcode = '23514';
        end if;
        if (NEW.kind = 'ROLLBACK' and ref.kind not in ('BET', 'WIN', 'REFUND')) or
          (NEW.kind in ('REFUND', 'WIN', 'LOSS') and ref.kind <> 'BET') or
          NEW.kind in ('BET', 'OPENING') then
          raise exception 'Invalid reference kind' using errcode = '23514';
        end if;
        if NEW.kind in ('REFUND', 'ROLLBACK') and NEW.amount <> ref.amount then
          raise exception 'Partial reversals are not supported' using errcode = '23514';
        end if;
        return NEW;
      end $$;
      create trigger valid_processed_reference before insert or update on wager_transactions
        for each row execute function check_processed_wager_reference();
    `);
  }

  override down(): void {
    this.addSql(`
      drop trigger valid_processed_reference on wager_transactions;
      drop function check_processed_wager_reference();
      drop index due_pending_references;
      alter table wager_transactions drop constraint pending_reference_is_scheduled;
      alter table wager_transactions drop column reference_attempts,
        drop column next_reference_attempt_at, drop column reference_expires_at;
    `);
  }
}

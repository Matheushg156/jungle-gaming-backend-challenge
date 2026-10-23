import { Migration } from '@mikro-orm/migrations';

export class Migration202610230005 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wager_transactions add column correlation_id varchar(255), add column causation_id varchar(255);
      -- Backfill transport metadata only. Financial fields remain unchanged under the migration lock.
      alter table wager_transactions disable trigger immutable_terminal_wager;
      update wager_transactions set correlation_id = id::text;
      alter table wager_transactions enable trigger immutable_terminal_wager;
      alter table wager_transactions alter column correlation_id set not null;

      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type varchar(255) not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz,
        check (published_at is null or next_attempt_at is null),
        check (coalesce(jsonb_typeof(payload) = 'object' and
          jsonb_typeof(payload->'eventId') = 'string' and payload->>'eventId' = id::text and
          jsonb_typeof(payload->'aggregateId') = 'string' and payload->>'aggregateId' = aggregate_id::text and
          jsonb_typeof(payload->'eventType') = 'string' and payload->>'eventType' = event_type and
          jsonb_typeof(payload->'correlationId') = 'string' and length(payload->>'correlationId') > 0 and
          jsonb_typeof(payload->'occurredAt') = 'string' and
          jsonb_typeof(payload->'version') = 'number' and (payload->>'version')::integer >= 1 and
          jsonb_typeof(payload->'data') = 'object', false))
      );
      create index due_outbox_messages on outbox_messages(occurred_at, id) where published_at is null;

      create function protect_outbox_message() returns trigger language plpgsql as $$
      begin
        if OLD.published_at is not null or
          (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at) is distinct from
          (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) then
          raise exception 'Outbox envelope and published messages are immutable' using errcode = '23514';
        end if;
        return NEW;
      end $$;
      create trigger immutable_outbox_envelope before update on outbox_messages
        for each row execute function protect_outbox_message();
    `);
  }

  override down(): void {
    this.addSql(`
      drop table outbox_messages;
      drop function protect_outbox_message();
      alter table wager_transactions drop column correlation_id, drop column causation_id;
    `);
  }
}

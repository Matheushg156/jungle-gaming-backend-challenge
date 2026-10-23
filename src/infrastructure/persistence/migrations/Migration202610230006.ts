import { Migration } from '@mikro-orm/migrations';

export class Migration202610230006 extends Migration {
  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(255) not null,
        message_id varchar(255) not null,
        payload_hash varchar(64) not null check (payload_hash ~ '^[a-f0-9]{64}$'),
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );
      create function protect_inbox_message() returns trigger language plpgsql as $$
      begin
        if old.processed_at is not null or
           (new.consumer_name, new.message_id, new.payload_hash, new.received_at)
           is distinct from (old.consumer_name, old.message_id, old.payload_hash, old.received_at) then
          raise exception 'Inbox identity and processed messages are immutable' using errcode = '23514';
        end if;
        return new;
      end $$;
      create trigger immutable_inbox before update on inbox_messages
        for each row execute function protect_inbox_message();
    `);
  }

  override down(): void {
    this.addSql(
      'drop table inbox_messages; drop function protect_inbox_message();',
    );
  }
}

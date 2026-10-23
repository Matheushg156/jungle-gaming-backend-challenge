import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { plainToInstance, Type } from 'class-transformer';
import {
  Equals,
  IsDefined,
  IsISO8601,
  IsString,
  Matches,
  ValidateIf,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { SubmitWagerDto } from '../../contracts/submit-wager.dto';
import { hashWagerPayload } from '../../application/wagering/hash-wager-payload';

class WagerMessageData extends SubmitWagerDto {
  @IsString()
  @Matches(/^[\x21-\x7e]{1,255}$/)
  idempotencyKey!: string;
}

class WagerMessage {
  @IsString()
  @Matches(/^[\x21-\x7e]{1,255}$/)
  messageId!: string;

  @Equals('WagerTransactionRequested')
  type!: string;

  @IsISO8601({ strict: true })
  occurredAt!: string;

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[a-zA-Z0-9._:-]{1,128}$/)
  correlationId?: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerMessageData)
  data!: WagerMessageData;
}

export class InvalidQueueMessage extends Error {
  readonly code = 'INVALID_QUEUE_MESSAGE';
  constructor() {
    super('Invalid wagering message envelope or data');
  }
}

export function parseWagerMessage(body: string) {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidQueueMessage();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidQueueMessage();
  }
  const envelope = value as Record<string, unknown>;
  const data = envelope.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new InvalidQueueMessage();
  }
  const money = (data as Record<string, unknown>).money;
  if (!money || typeof money !== 'object' || Array.isArray(money)) {
    throw new InvalidQueueMessage();
  }
  const message = plainToInstance(WagerMessage, value);
  if (
    validateSync(message, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }).length
  ) {
    throw new InvalidQueueMessage();
  }
  const { idempotencyKey, ...input } = message.data;
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify({
        type: message.type,
        idempotencyKey,
        businessHash: hashWagerPayload(input),
      }),
    )
    .digest('hex');
  return {
    messageId: message.messageId,
    correlationId: message.correlationId ?? message.messageId,
    input,
    idempotencyKey,
    payloadHash,
  };
}

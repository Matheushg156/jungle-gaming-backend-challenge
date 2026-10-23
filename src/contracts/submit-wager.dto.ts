import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  NotEquals,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { WagerTransactionKind } from '../domain/entities/wager-transaction';

class WagerMoneyDto {
  @IsString()
  @Matches(/^(0|[1-9]\d{0,15})\.\d{2}$/)
  amount!: string;

  @IsIn(['BRL', 'USD', 'EUR'])
  currency!: string;
}

export class SubmitWagerDto {
  @IsString()
  @Matches(/^\S+$/)
  @MaxLength(255)
  @NotEquals('__internal__')
  providerId!: string;

  @IsString()
  @Matches(/^\S+$/)
  @MaxLength(255)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\S+$/)
  @MaxLength(255)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\S+$/)
  @MaxLength(255)
  gameId!: string;

  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerMoneyDto)
  money!: WagerMoneyDto;

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^\S+$/)
  @MaxLength(255)
  referenceExternalTransactionId?: string;
}

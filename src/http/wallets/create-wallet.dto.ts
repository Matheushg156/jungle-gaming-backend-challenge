import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

class InitialBalanceDto {
  @IsString()
  @Matches(/^(0|[1-9]\d{0,15})\.\d{2}$/)
  amount!: string;

  @IsIn(['BRL', 'USD', 'EUR'])
  currency!: string;
}

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => InitialBalanceDto)
  initialBalance!: InitialBalanceDto;
}

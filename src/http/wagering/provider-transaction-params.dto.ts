import { IsString, Matches, MaxLength } from 'class-validator';

export class ProviderTransactionParamsDto {
  @IsString()
  @Matches(/^\S+$/)
  @MaxLength(255)
  providerId!: string;

  @IsString()
  @Matches(/^\S+$/)
  @MaxLength(255)
  externalTransactionId!: string;
}

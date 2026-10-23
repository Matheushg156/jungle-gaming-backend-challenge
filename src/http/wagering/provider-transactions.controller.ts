import {
  Controller,
  Get,
  Inject,
  Param,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { WagerReadRepository } from '../../application/ports/wager-read.repository';
import { DomainError } from '../../domain/errors/domain-error';
import { ProviderIdentityGuard } from '../provider-identity.guard';
import { ProviderTransactionParamsDto } from './provider-transaction-params.dto';

@Controller('providers/:providerId/wagering/transactions')
@UseGuards(ProviderIdentityGuard)
export class ProviderTransactionsController {
  constructor(
    @Inject(WagerReadRepository) private readonly wagers: WagerReadRepository,
  ) {}

  @Get(':externalTransactionId')
  async findByExternalId(
    @Param(
      new ValidationPipe({
        expectedType: ProviderTransactionParamsDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    params: ProviderTransactionParamsDto,
  ) {
    const result = await this.wagers.findByExternalId(
      params.providerId,
      params.externalTransactionId,
    );
    if (!result) {
      throw new DomainError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    }
    return result;
  }
}

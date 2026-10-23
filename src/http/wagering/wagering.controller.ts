import {
  Body,
  Controller,
  Headers,
  Get,
  Param,
  ParseUUIDPipe,
  Inject,
  Post,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { SubmitWager } from '../../application/wagering/submit-wager';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import { DomainError } from '../../domain/errors/domain-error';
import { ProviderIdentityGuard } from '../provider-identity.guard';
import { readCorrelationId } from '../read-correlation-id';
import { SubmitWagerDto } from './submit-wager.dto';
import { WagerReadRepository } from '../../application/ports/wager-read.repository';

interface HttpStatusResponse {
  status(code: number): unknown;
}

@Controller('wagering/transactions')
@UseGuards(ProviderIdentityGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWager) private readonly submitWager: SubmitWager,
    @Inject(WagerReadRepository) private readonly wagers: WagerReadRepository,
  ) {}

  @Get(':transactionId')
  async findById(
    @Param('transactionId', new ParseUUIDPipe()) transactionId: string,
  ) {
    const transaction = await this.wagers.findById(transactionId);
    if (!transaction) {
      throw new DomainError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    }
    return transaction;
  }

  @Post()
  async submit(
    @Headers('idempotency-key') key: string | undefined,
    @Body(
      new ValidationPipe({
        expectedType: SubmitWagerDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    input: SubmitWagerDto,
    @Res({ passthrough: true }) response: HttpStatusResponse,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    if (!key) {
      throw new DomainError(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key header is required',
      );
    }
    const result = await this.submitWager.execute(input, key, {
      correlationId: readCorrelationId(correlationId),
    });
    if (result.status === WagerTransactionStatus.Rejected) {
      response.status(422);
    } else if (result.status === WagerTransactionStatus.PendingReference) {
      response.status(202);
    } else {
      response.status(200);
    }
    return result;
  }
}

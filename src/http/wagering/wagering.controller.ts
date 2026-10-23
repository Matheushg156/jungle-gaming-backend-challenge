import {
  Body,
  Controller,
  Headers,
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
import { SubmitWagerDto } from './submit-wager.dto';

interface HttpStatusResponse {
  status(code: number): unknown;
}

@Controller('wagering/transactions')
@UseGuards(ProviderIdentityGuard)
export class WageringController {
  constructor(@Inject(SubmitWager) private readonly submitWager: SubmitWager) {}

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
  ) {
    if (!key) {
      throw new DomainError(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key header is required',
      );
    }
    const result = await this.submitWager.execute(input, key);
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

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { WalletRepository } from '../../application/ports/wallet.repository';
import { OpenWallet } from '../../application/wallets/open-wallet';
import { Wallet } from '../../domain/entities/wallet';
import { DomainError } from '../../domain/errors/domain-error';
import { ProviderIdentityGuard } from '../provider-identity.guard';
import { CreateWalletDto } from './create-wallet.dto';
import { LedgerQueryDto } from './ledger-query.dto';
import { ListWalletLedger } from '../../application/wallets/list-wallet-ledger';
import { ReconcileWallet } from '../../application/wallets/reconcile-wallet';

@Controller('wallets')
@UseGuards(ProviderIdentityGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
    @Inject(ListWalletLedger) private readonly listLedger: ListWalletLedger,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  async create(
    @Body(
      new ValidationPipe({
        expectedType: CreateWalletDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    input: CreateWalletDto,
  ) {
    try {
      return this.toResponse(await this.openWallet.execute(input));
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        const body = { code: error.code, message: error.message };
        if (error.code === 'WALLET_ALREADY_EXISTS') {
          throw new ConflictException(body);
        }
        throw new BadRequestException(body);
      }
      throw error;
    }
  }

  @Get(':walletId')
  async findById(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new NotFoundException({
        code: 'WALLET_NOT_FOUND',
        message: 'Wallet not found',
      });
    }
    return this.toResponse(wallet);
  }

  @Get(':walletId/ledger')
  getLedger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query(
      new ValidationPipe({
        expectedType: LedgerQueryDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    query: LedgerQueryDto,
  ) {
    return this.listLedger.execute(
      walletId,
      query.limit === undefined ? 50 : Number(query.limit),
      query.cursor,
    );
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ) {
    if (
      correlationId !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(correlationId)
    ) {
      throw new DomainError(
        'INVALID_CORRELATION_ID',
        'X-Correlation-Id must contain 1 to 128 letters, digits, dots, underscores, colons or hyphens',
      );
    }
    return this.reconcileWallet.execute(walletId, correlationId);
  }

  private toResponse(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}

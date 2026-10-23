import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { WalletRepository } from '../../application/ports/wallet.repository';
import { OpenWallet } from '../../application/wallets/open-wallet';
import { Wallet } from '../../domain/entities/wallet';
import { DomainError } from '../../domain/errors/domain-error';
import { ProviderIdentityGuard } from '../provider-identity.guard';
import { CreateWalletDto } from './create-wallet.dto';

@Controller('wallets')
@UseGuards(ProviderIdentityGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletRepository) private readonly wallets: WalletRepository,
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

  private toResponse(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}

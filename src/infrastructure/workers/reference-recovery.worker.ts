import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { RetryPendingReferences } from '../../application/wagering/retry-pending-references';

@Injectable()
export class ReferenceRecoveryWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ReferenceRecoveryWorker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(RetryPendingReferences)
    private readonly retry: RetryPendingReferences,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = process.env.REFERENCE_RECOVERY_ENABLED ?? 'true';
    if (enabled !== 'true' && enabled !== 'false') {
      throw new Error('REFERENCE_RECOVERY_ENABLED must be true or false');
    }
    if (enabled === 'false') {
      return;
    }
    this.timer = setInterval(() => {
      this.tick();
    }, 1000);
  }

  private tick(): void {
    // This flag prevents overlapping timer callbacks only. PostgreSQL guarantees correctness across instances.
    if (this.inFlight) {
      return;
    }
    this.inFlight = this.retry
      .execute()
      .then(() => undefined)
      .catch(() => {
        this.logger.error({
          code: 'REFERENCE_RECOVERY_RETRY',
          message: 'Reference recovery failed; will retry on next tick',
        });
      })
      .finally(() => {
        this.inFlight = undefined;
      });
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.inFlight;
  }
}

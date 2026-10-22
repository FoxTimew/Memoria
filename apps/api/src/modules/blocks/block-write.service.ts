import type { BlockBatch, RequestContext, SystemContext } from '@memoria/contracts';
import type { WriteTransaction } from '@memoria/db';

/** Contract only. No SQL writer is implemented in the architecture session. */
export interface BlockWriteService {
  /**
   * One batch = one page version increment, audit, search projection and outbox.
   * The caller opens the transaction; this service owns block validation/writes.
   * A mismatch raises VERSION_CONFLICT (web:409, public If-Match:412).
   */
  apply(
    context: RequestContext | SystemContext,
    transaction: WriteTransaction,
    input: BlockBatch & { pageId: string; expectedVersion: number },
  ): Promise<{ pageId: string; version: number; changedBlockIds: readonly string[] }>;
  /** Retention worker entry point. No other service deletes block rows directly. */
  purge(context: SystemContext, transaction: WriteTransaction, pageId: string): Promise<void>;
}

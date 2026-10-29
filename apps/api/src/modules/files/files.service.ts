import { Injectable, BadRequestException, HttpException } from '@nestjs/common';
import { z } from 'zod';
import { FileFault } from '@memoria/db';
import * as database from '../../database.module.ts';
import { UploadService } from '@memoria/storage/uploads';
import { storageConfig } from '@memoria/storage/config';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import { DatabaseAdmission } from '../databases/database-quota.ts';
const checksum = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const initial = z.strictObject({
  pageId: z.uuid(),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().min(1).max(255),
  idempotency: z.uuid(),
  checksum,
});
const signing = z.strictObject({
  request: z.uuid(),
  parts: z
    .array(
      z.strictObject({
        number: z.number().int().min(1).max(10000),
        bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        checksum,
      }),
    )
    .min(1)
    .max(4),
});
const empty = z.strictObject({});
@Injectable()
export class FilesService {
  private uploads?: UploadService;
  private readonly admission = new DatabaseAdmission(4, 20, 1000);
  constructor(private readonly database: database.DatabaseService) {}
  get transport() {
    return (this.uploads ??= new UploadService(this.database.pool, storageConfig()));
  }
  onApplicationShutdown() {
    this.uploads?.close();
  }
  private parse<T>(schema: z.ZodType<T>, body: unknown) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_FILE_REQUEST' });
    return parsed.data;
  }
  async invoke(
    session: AuthenticatedSession,
    workspace: string,
    action: 'initiate' | 'pending' | 'status' | 'resume' | 'sign' | 'complete' | 'cancel',
    id: string | undefined,
    body: unknown = {},
  ) {
    if (!z.uuid().safeParse(workspace).success || (id && !z.uuid().safeParse(id).success))
      throw new BadRequestException({ code: 'INVALID_FILE_REQUEST' });
    return this.admission.run(async () => {
      try {
        if (action === 'initiate' || action === 'pending') {
          const input = this.parse(
            action === 'initiate' ? initial : z.strictObject({ pageId: z.uuid() }),
            body,
          );
          const row = (
            await this.database.pool.query<{ database_id: string }>(
              'SELECT database_id FROM database_rows WHERE workspace_id=$1 AND page_id=$2',
              [workspace, input.pageId],
            )
          ).rows[0];
          const actor = {
            key: session.id,
            session: session.id,
            user: session.userId,
            workspace,
            page: input.pageId,
            ...(row ? { rowScope: { database: row.database_id } } : {}),
          };
          return action === 'pending'
            ? await this.transport.pending(actor)
            : await this.transport.initiate(actor, this.parse(initial, body));
        }
        const context = await this.transport.context(session.userId, session.id, workspace, id!);
        if (action === 'sign') {
          const input = this.parse(signing, body);
          return await this.transport.sign(context, id!, input.request, input.parts);
        }
        if (action !== 'status') this.parse(empty, body);
        return await this.transport[action](context, id!);
      } catch (error) {
        if (error instanceof HttpException || error instanceof FileFault) throw error;
        // Only fixed FileFault codes may escape; SDK failures contain signed URLs and object keys.
        throw new HttpException({ code: 'STORAGE_UNAVAILABLE', retryAfter: 2 }, 503);
      }
    });
  }
}

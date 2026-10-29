import { Injectable, BadRequestException, HttpException } from '@nestjs/common';
import { z } from 'zod';
import { FileReading, FileFault, resolvePageAccess } from '@memoria/db';
import { ReadTickets } from '@memoria/storage/read-ticket';
import * as database from '../../database.module.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import { DatabaseAdmission } from '../databases/database-quota.ts';
const resolveBody = z.strictObject({ pageId: z.uuid(), files: z.array(z.uuid()).max(100) });
const ticketBody = z.strictObject({
  pageId: z.uuid(),
  files: z
    .array(z.strictObject({ id: z.uuid(), variant: z.enum(['original', 'display', 'thumbnail']) }))
    .min(1)
    .max(100),
});
const lifecycle = z.strictObject({ pageId: z.uuid(), version: z.number().int().positive() });
@Injectable()
export class FileReadService {
  private readonly admission = new DatabaseAdmission(4, 20, 1000);
  constructor(private readonly database: database.DatabaseService) {}
  async invoke(
    s: AuthenticatedSession,
    w: string,
    action: 'resolve' | 'select' | 'tickets' | 'archive' | 'restore',
    body: unknown,
    id?: string,
  ) {
    if (!z.uuid().safeParse(w).success || (id && !z.uuid().safeParse(id).success))
      throw new BadRequestException({ code: 'INVALID_FILE_REQUEST' });
    return this.admission.run(async () => {
      try {
        const service = new FileReading(this.database.pool);
        const a = (page: string) => ({
          key: 'file-control',
          session: s.id,
          user: s.userId,
          workspace: w,
          page,
        });
        if (action === 'select') {
          const parsed = z.strictObject({ pageId: z.uuid() }).safeParse(body);
          if (!parsed.success) throw new BadRequestException({ code: 'INVALID_FILE_REQUEST' });
          const row = (
            await this.database.pool.query<{ database_id: string }>(
              'SELECT database_id FROM database_rows WHERE workspace_id=$1 AND page_id=$2',
              [w, parsed.data.pageId],
            )
          ).rows[0];
          const request = {
            ...a(parsed.data.pageId),
            ...(row ? { rowScope: { database: row.database_id } } : {}),
          };
          if (!(await resolvePageAccess(this.database.pool, [request])).has(request.key))
            return { items: [] };
          const candidates = (
            await this.database.pool.query<{ file_id: string }>(
              'SELECT DISTINCT file_id FROM file_usages WHERE workspace_id=$1 AND page_id=$2 ORDER BY file_id LIMIT 100',
              [w, parsed.data.pageId],
            )
          ).rows;
          const items = [];
          for (const entry of candidates)
            try {
              items.push(await service.metadata(a(parsed.data.pageId), entry.file_id));
            } catch (e) {
              if (!(e instanceof FileFault && e.code === 'FILE_UNAVAILABLE')) throw e;
            }
          return { items };
        }
        if (action === 'archive' || action === 'restore') {
          const parsed = lifecycle.safeParse(body);
          if (!parsed.success) throw new BadRequestException({ code: 'INVALID_FILE_REQUEST' });
          return await service.lifecycle(
            a(parsed.data.pageId),
            id!,
            parsed.data.version,
            action === 'restore',
          );
        }
        const parsed = (action === 'resolve' ? resolveBody : ticketBody).safeParse(body);
        if (!parsed.success) throw new BadRequestException({ code: 'INVALID_FILE_REQUEST' });
        let unavailable = false;
        const items: unknown[] = [];
        for (const entry of parsed.data.files) {
          const file = typeof entry === 'string' ? entry : entry.id;
          try {
            if (action === 'resolve')
              items.push(await service.metadata(a(parsed.data.pageId), file));
            else {
              const origin = new URL(process.env.FILES_ORIGIN ?? 'https://files.localhost');
              if (
                origin.protocol !== 'https:' ||
                origin.origin !== (process.env.FILES_ORIGIN ?? 'https://files.localhost') ||
                origin.origin === process.env.APP_ORIGIN ||
                origin.origin === process.env.S3_PUBLIC_ENDPOINT
              )
                throw Error('INVALID_FILES_ORIGIN');
              const variant = typeof entry === 'string' ? 'original' : entry.variant;
              const claim = await service.issue(a(parsed.data.pageId), file, variant);
              items.push({
                id: file,
                variant,
                url:
                  origin.origin +
                  '/v1/files/' +
                  new ReadTickets(process.env.BETTER_AUTH_SECRET!).issue(claim),
                expiresIn: 60,
              });
            }
          } catch (e) {
            if (e instanceof FileFault && e.code === 'FILE_UNAVAILABLE') unavailable = true;
            else throw e;
          }
        }
        return { items, unavailable };
      } catch (e) {
        if (e instanceof FileFault || e instanceof HttpException) throw e;
        throw new HttpException({ code: 'FILE_SERVICE_UNAVAILABLE' }, 503);
      }
    });
  }
}

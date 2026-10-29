import { Injectable, BadRequestException, HttpException } from '@nestjs/common';
import { z } from 'zod';
import { FileReading, FileFault } from '@memoria/db';
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
    action: 'resolve' | 'tickets' | 'archive' | 'restore',
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

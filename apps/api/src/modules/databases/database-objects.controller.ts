import { Body, Controller, Get, Post, Patch, Put, Param, Query, HttpCode } from '@nestjs/common';
import { CurrentSession } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import * as objects from './database-objects.service.ts';
import { DatabaseQuota } from './database-quota.ts';
import { AccessQuota } from '../workspaces/access-quota.ts';
@Controller('api/internal/workspaces/:workspaceId/databases')
export class DatabaseObjectsController {
  constructor(private readonly objects: objects.DatabaseObjectsService) {}
  @Get('')
  @HttpCode(200)
  @DatabaseQuota('L')
  route0(@CurrentSession() s: AuthenticatedSession, @Param('workspaceId') w: string) {
    return this.objects.list(s, w);
  }
  @Post('')
  @HttpCode(200)
  @DatabaseQuota('S')
  route1(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Body() body: unknown,
  ) {
    return this.objects.create(s, w, body);
  }
  @Get(':databaseId')
  @HttpCode(200)
  @DatabaseQuota('L')
  route2(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
  ) {
    return this.objects.get(s, w, b);
  }
  @Patch(':databaseId')
  @HttpCode(200)
  @DatabaseQuota('S')
  route3(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Body() body: unknown,
  ) {
    return this.objects.view(s, w, b, body);
  }
  @Post(':databaseId/properties')
  @HttpCode(200)
  @DatabaseQuota('S')
  route4(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Body() body: unknown,
  ) {
    return this.objects.property(s, w, b, undefined, body);
  }
  @Patch(':databaseId/properties/:propertyId')
  @HttpCode(200)
  @DatabaseQuota('S')
  route5(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('propertyId') p: string,
    @Body() body: unknown,
  ) {
    return this.objects.property(s, w, b, p, body);
  }
  @Post(':databaseId/properties/:propertyId/options')
  @HttpCode(200)
  @DatabaseQuota('S')
  route6(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('propertyId') p: string,
    @Body() body: unknown,
  ) {
    return this.objects.option(s, w, b, p, undefined, body);
  }
  @Patch(':databaseId/properties/:propertyId/options/:optionId')
  @HttpCode(200)
  @DatabaseQuota('S')
  route7(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('propertyId') p: string,
    @Param('optionId') o: string,
    @Body() body: unknown,
  ) {
    return this.objects.option(s, w, b, p, o, body);
  }
  @Post(':databaseId/rows')
  @HttpCode(200)
  @DatabaseQuota('C')
  route8(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Body() body: unknown,
  ) {
    return this.objects.createRow(s, w, b, body);
  }
  @Get(':databaseId/rows/:rowId')
  @HttpCode(200)
  @DatabaseQuota('L')
  route9(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('rowId') r: string,
  ) {
    return this.objects.row(s, w, b, r);
  }
  @Patch(':databaseId/rows/:rowId')
  @HttpCode(200)
  @DatabaseQuota('E')
  route10(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('rowId') r: string,
    @Body() body: unknown,
  ) {
    return this.objects.renameRow(s, w, b, r, body);
  }
  @Get(':databaseId/rows/:rowId/cells/:propertyId')
  @HttpCode(200)
  @DatabaseQuota('L')
  route11(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('rowId') r: string,
    @Param('propertyId') p: string,
  ) {
    return this.objects.cell(s, w, b, r, p);
  }
  @Patch(':databaseId/rows/:rowId/cells/:propertyId')
  @HttpCode(200)
  @DatabaseQuota('E')
  route12(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('rowId') r: string,
    @Param('propertyId') p: string,
    @Body() body: unknown,
  ) {
    return this.objects.cell(s, w, b, r, p, body);
  }
  @Post(':databaseId/rows/:rowId/archive')
  @HttpCode(200)
  @DatabaseQuota('C')
  route13(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('rowId') r: string,
    @Body() body: unknown,
  ) {
    return this.objects.lifecycle(s, w, b, r, body, true);
  }
  @Post(':databaseId/rows/:rowId/restore')
  @HttpCode(200)
  @DatabaseQuota('C')
  route14(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('rowId') r: string,
    @Body() body: unknown,
  ) {
    return this.objects.lifecycle(s, w, b, r, body, false);
  }
  @Get(':databaseId/trash')
  @HttpCode(200)
  @DatabaseQuota('L')
  route15(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Query() query: unknown,
  ) {
    return this.objects.trash(s, w, b, query);
  }
  @Post(':databaseId/properties/:propertyId/choices')
  @HttpCode(200)
  @DatabaseQuota('L')
  route16(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('propertyId') p: string,
    @Body() body: unknown,
  ) {
    return this.objects.choices(s, w, b, p, body);
  }
  @Get(':databaseId/assignable-people')
  @HttpCode(200)
  @DatabaseQuota('L')
  route17(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
  ) {
    return this.objects.assignable(s, w, b);
  }
  @Put(':databaseId/assignable-people')
  @HttpCode(200)
  @AccessQuota('mutate')
  route18(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Body() body: unknown,
  ) {
    return this.objects.assignable(s, w, b, body);
  }
}

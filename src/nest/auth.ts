import { createParamDecorator, Inject, Injectable, Module } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { requireSubject } from '../server/auth.ts';
import { HttpError } from '../server/http.ts';
import type { ApiRequest } from './http.ts';

@Injectable()
export class AuthService { authenticate(request: Request) { return requireSubject(request); } }
@Injectable()
export class ClerkGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    request.subject = await this.auth.authenticate(request.api);
    return true;
  }
}
/** Legacy community reads require GET even when Express matches HEAD to @Get.
 * Method guards run after the controller's ClerkGuard and before argument pipes. */
@Injectable()
export class CommunityReadMethodGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.switchToHttp().getRequest<ApiRequest>().method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método inválido.');
    }
    return true;
  }
}
@Module({ providers: [AuthService, ClerkGuard, CommunityReadMethodGuard], exports: [AuthService, ClerkGuard, CommunityReadMethodGuard] })
export class AuthModule {}
export const Subject = createParamDecorator((_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<ApiRequest>().subject);

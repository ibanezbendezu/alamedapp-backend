import 'reflect-metadata';
import { Module, RequestMethod } from '@nestjs/common';
import type { Provider, Type } from '@nestjs/common';
import { MODULE_METADATA, PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Response as ExpressResponse } from 'express';
import { HealthModule, ProfilesModule, PrayersModule, CommunityModule, StreaksModule, WalletModule } from './nest/modules.ts';
import { contextHeaders, SafeExceptionFilter } from './nest/http.ts';
import type { ApiRequest } from './nest/http.ts';
import { apiHandler, HttpError } from './server/http.ts';

@Module({imports:[HealthModule,ProfilesModule,PrayersModule,CommunityModule,StreaksModule,WalletModule]})
export class AppModule {}
export type ProviderOverride = {provide: Type<unknown>; useValue: unknown};
/** DI overrides replace providers in their owning modules, including shared auth/database. */
function withOverrides(root: Type<unknown>, overrides: ProviderOverride[], cache = new Map<Type<unknown>,Type<unknown>>()): Type<unknown> {
  const existing = cache.get(root); if (existing) return existing;
  class OverriddenModule {}
  cache.set(root,OverriddenModule);
  const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS,root) ?? []) as Provider[];
  const replacements = providers.map(provider => {
    const token = typeof provider === 'function' ? provider : 'provide' in provider ? provider.provide : provider;
    return overrides.find(value => value.provide === token) ?? provider;
  });
  Module({
    imports: ((Reflect.getMetadata(MODULE_METADATA.IMPORTS,root) ?? []) as Type<unknown>[]).map(value => withOverrides(value,overrides,cache)),
    controllers: Reflect.getMetadata(MODULE_METADATA.CONTROLLERS,root) ?? [],
    providers: replacements,
    exports: Reflect.getMetadata(MODULE_METADATA.EXPORTS,root) ?? [],
  })(OverriddenModule);
  return OverriddenModule;
}
export function declaredRoutes(root: Type<unknown> = AppModule): {method: string; path: string}[] {
  const entries: {method:string;path:string}[] = [];
  const seen = new Set<Type<unknown>>();
  const visit = (module: Type<unknown>) => {
    if (seen.has(module)) return; seen.add(module);
    for (const controller of (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS,module) ?? []) as Type<unknown>[]) {
      const prefix = Reflect.getMetadata(PATH_METADATA,controller) ?? '';
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name];
        const method = Reflect.getMetadata(METHOD_METADATA,handler);
        if (method === undefined) continue;
        const path = '/' + [prefix,Reflect.getMetadata(PATH_METADATA,handler)].filter(Boolean).join('/').replace(/^\/+|\/+$/g,'');
        entries.push({method:RequestMethod[method],path});
      }
    }
    for (const imported of Reflect.getMetadata(MODULE_METADATA.IMPORTS,module) ?? []) visit(imported);
  };
  visit(root); return entries;
}
export async function createApplication(overrides: ProviderOverride[] = []) {
  const app = await NestFactory.create(overrides.length ? withOverrides(AppModule,overrides) : AppModule, {bodyParser:false,logger:false});
  const declarations = declaredRoutes();
  const patterns = declarations.map(route => new RegExp('^'+route.path.replace(/:[^/]+/g,'[^/]+')+'/?$'));
  const knownPath = (path: string) => patterns.some(pattern => pattern.test(path));
  app.use(async (request: ApiRequest,response: ExpressResponse,next: NextFunction) => {
    contextHeaders(request,response);
    if (request.method === 'OPTIONS' && knownPath(request.path)) {response.status(204).end();return;}
    // Reserved literal paths keep their method policy ahead of parameter routes.
    const literal = declarations.filter(route => !route.path.includes(':') && route.path === request.path.replace(/\/$/,''));
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    if (literal.length && !literal.some(route => route.method === method)) {
      const failure = await apiHandler(() => {throw new HttpError(405,'METHOD_NOT_ALLOWED','Método no permitido.');})(request.api);
      response.status(failure.status);
      failure.headers.forEach((value,key) => response.setHeader(key,value));
      if (request.method === 'HEAD') response.end(); else response.end(await failure.text());
      return;
    }
    next();
  });
  app.useGlobalFilters(new SafeExceptionFilter(knownPath));
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  return app;
}

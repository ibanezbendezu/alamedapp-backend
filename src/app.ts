import 'reflect-metadata';
import { All, Catch, Controller, HttpException, Inject, Injectable, Module, Req, Res } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import * as routes from './server/routes.ts';
import { apiHandler, HttpError, preflight } from './server/http.ts';

type Handler = (request: Request) => Promise<Response> | Response;
export type Route = { path: string; methods: Record<string, (request: Request, parameter: string) => Promise<Response> | Response> };
const context = (id: string) => ({params: Promise.resolve({id})});
export const defaultRoutes: Route[] = [
  {path: '/api/health', methods: {GET: routes.health}},
  {path: '/api/ready', methods: {GET: routes.ready}},
  {path: '/api/v1/me', methods: {GET: routes.me, PATCH: routes.patchMe}},
  {path: '/api/v1/me/sync', methods: {POST: routes.sync}},
  {path: '/api/v1/me/medals', methods: {GET: routes.ownMedals}},
  {path: '/api/v1/medals', methods: {GET: routes.medals}},
  {path: '/api/v1/prayers', methods: {GET: routes.prayers, POST: routes.createPrayer}},
  {path: '/api/v1/prayers/order', methods: {PUT: routes.orderPrayers}},
  {path: '/api/v1/prayers/:id', methods: {PATCH: (r,id) => routes.patchPrayer(r,context(id)), DELETE: (r,id) => routes.deletePrayer(r,context(id))}},
  {path: '/api/v1/users/:id/prayers', methods: {GET: (r,id) => routes.userPrayers(r,context(id))}},
  {path: '/api/v1/community/:operation', methods: {GET: routes.community, POST: routes.community}},
];
const safeError = (status: number, code: string, message: string): Handler => apiHandler(() => {throw new HttpError(status, code, message);});

export class HttpService {
  constructor(readonly endpoints: Route[] = defaultRoutes) {}
  async dispatch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname.replace(/\/$/, '') || '/';
    for (const route of this.endpoints) {
      const match = new RegExp('^' + route.path.replace(/:[^/]+/g, '([^/]+)') + '$').exec(pathname);
      if (!match) continue;
      if (request.method === 'OPTIONS') return preflight(request);
      const handler = route.methods[request.method === 'HEAD' ? 'GET' : request.method];
      if (!handler) return safeError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.')(request);
      let parameter: string;
      try { parameter = decodeURIComponent(match[1] ?? ''); }
      catch { return safeError(400, 'INVALID_PATH', 'Ruta no válida.')(request); }
      return handler(request, parameter);
    }
    return safeError(404, 'NOT_FOUND', 'Ruta no encontrada.')(request);
  }
}
Injectable()(HttpService);

export class ApiController {
  constructor(readonly service: HttpService) {}
  async handle(incoming: ExpressRequest, outgoing: ExpressResponse) {
    // Leave the incoming stream untouched until the authenticated Fetch handler reads it.
    const headers = new Headers();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i+1]);
    const hasBody = !['GET', 'HEAD'].includes(incoming.method);
    const iterator = hasBody ? incoming.iterator({destroyOnReturn: false}) : undefined;
    const body = iterator ? new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await iterator.next();
        if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
      },
      async cancel() { await iterator.return?.(); incoming.resume(); },
    }, {highWaterMark: 0}) : undefined;
    const request = new Request(`http://localhost${incoming.originalUrl}`, {
      method: incoming.method, headers,
      ...(hasBody ? {body, duplex: 'half'} : {}),
    } as RequestInit);
    let response: Response;
    try { response = await this.service.dispatch(request); }
    catch { response = await apiHandler(() => {throw new Error();})(request); }
    outgoing.status(response.status);
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    if (incoming.method === 'HEAD' || response.status === 204) outgoing.end();
    else outgoing.end(Buffer.from(await response.arrayBuffer()));
  }
}
Controller()(ApiController);
Inject(HttpService)(ApiController, undefined, 0);
All('{*path}')(ApiController.prototype, 'handle', Object.getOwnPropertyDescriptor(ApiController.prototype, 'handle')!);
Req()(ApiController.prototype, 'handle', 0);
Res()(ApiController.prototype, 'handle', 1);

class SafeExceptionFilter implements ExceptionFilter {
  async catch(error: unknown, host: ArgumentsHost) {
    const incoming = host.switchToHttp().getRequest<ExpressRequest>();
    const outgoing = host.switchToHttp().getResponse<ExpressResponse>();
    const invalid = error instanceof URIError || error instanceof HttpException && error.getStatus() === 400;
    const request = new Request('http://localhost' + incoming.originalUrl, {headers: typeof incoming.headers.origin === 'string' ? {origin: incoming.headers.origin} : {}});
    const response = await (invalid ? safeError(400, 'INVALID_PATH', 'Ruta no válida.') : apiHandler(() => {throw new Error();}))(request);
    outgoing.status(response.status);
    response.headers.forEach((value,key) => outgoing.setHeader(key,value));
    outgoing.end(await response.text());
  }
}
Catch()(SafeExceptionFilter);

export class AppModule {}
Module({controllers: [ApiController], providers: [HttpService]})(AppModule);
export async function createApplication(endpoints?: Route[]) {
  const module = endpoints ? class TestModule {} : AppModule;
  if (endpoints) Module({controllers: [ApiController], providers: [{provide: HttpService, useValue: new HttpService(endpoints)}]})(module);
  const app = await NestFactory.create(module, {bodyParser: false, logger: false});
  app.useGlobalFilters(new SafeExceptionFilter());
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  return app;
}

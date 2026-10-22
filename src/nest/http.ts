import { Catch, createParamDecorator, Injectable } from '@nestjs/common';
import type { ArgumentsHost, CanActivate, ExecutionContext, ExceptionFilter, PipeTransform } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { apiHandler, HttpError, responseHeaders } from '../server/http.ts';
import { readBody } from '../server/handlers.ts';

export type ApiRequest = ExpressRequest & { api: Request; subject: string };
export { AuthService, AuthModule, ClerkGuard, Subject } from './auth.ts';
export const Input = createParamDecorator((_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<ApiRequest>());
@Injectable()
export class PrayerGate implements CanActivate {
  canActivate() {
    if (process.env.PRAYERS_API_ENABLED !== 'true') throw new HttpError(503, 'PRAYERS_NOT_ACTIVE', 'El diario de oración aún no está disponible.');
    return true;
  }
}
export class JsonDtoPipe<T> implements PipeTransform<ApiRequest, Promise<T>> {
  constructor(private readonly validate: (value: unknown) => T, private readonly invalid: () => HttpError, private readonly limit = 32768) {}
  async transform(request: ApiRequest) {
    let value: unknown;
    try { value = JSON.parse(await readBody(request.api, this.limit)); }
    catch (error) { if (error instanceof HttpError) throw error; throw this.invalid(); }
    return this.validate(value);
  }
}
export class SyncDtoPipe implements PipeTransform<ApiRequest, Promise<Record<string, never>>> {
  async transform(request: ApiRequest) {
    const text = await readBody(request.api);
    const invalid = () => new HttpError(400, 'INVALID_BODY', 'La solicitud debe estar vacía.');
    let value: unknown = {};
    if (text.trim()) { try { value = JSON.parse(text); } catch { throw invalid(); } }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw invalid();
    return {};
  }
}
export function fetchRequest(incoming: ExpressRequest) {
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i+1]);
  const hasBody = !['GET', 'HEAD'].includes(incoming.method);
  const iterator = hasBody ? incoming.iterator({destroyOnReturn: false}) : undefined;
  const body = iterator ? new ReadableStream<Uint8Array>({
    async pull(controller) { const chunk = await iterator.next(); if (chunk.done) controller.close(); else controller.enqueue(chunk.value); },
    async cancel() { await iterator.return?.(); incoming.resume(); },
  }, {highWaterMark: 0}) : undefined;
  return new Request(`http://localhost${incoming.originalUrl}`, { method: incoming.method, headers,
    ...(hasBody ? {body, duplex: 'half'} : {}),
  } as RequestInit);
}
export function contextHeaders(request: ApiRequest, response: ExpressResponse) {
  request.api = fetchRequest(request);
  responseHeaders(request.api, crypto.randomUUID()).forEach((value,key) => response.setHeader(key,value));
}
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  constructor(private readonly knownPath: (path: string) => boolean) {}
  async catch(error: unknown, host: ArgumentsHost) {
    const incoming = host.switchToHttp().getRequest<ApiRequest>();
    const outgoing = host.switchToHttp().getResponse<ExpressResponse>();
    let failure = error;
    if (error instanceof URIError || error instanceof HttpException && error.getStatus() === 400) failure = new HttpError(400, 'INVALID_PATH', 'Ruta no válida.');
    else if (error instanceof HttpException && error.getStatus() === 404) {
      failure = this.knownPath(incoming.path) ? new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.') : new HttpError(404, 'NOT_FOUND', 'Ruta no encontrada.');
    }
    const request = incoming.api ?? new Request('http://localhost/', {headers: typeof incoming.headers.origin === 'string' ? {origin: incoming.headers.origin} : {}});
    const response = await apiHandler(() => {throw failure;})(request);
    outgoing.status(response.status);
    response.headers.forEach((value,key) => outgoing.setHeader(key,value));
    if (incoming.method === 'HEAD') outgoing.end(); else outgoing.end(await response.text());
  }
}


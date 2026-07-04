import type { Response } from 'express';

export interface PublicSuccessPayload {
  code: number;
  status: 'success';
  response: string;
  [key: string]: unknown;
}

export interface PublicErrorPayload {
  code: number;
  status: 'failed';
  response: string;
}

export function sendPublicSuccess<T extends Record<string, unknown>>(
  response: Response,
  statusCode: number,
  message: string,
  data?: T
): Response {
  return response.status(statusCode).json({
    code: statusCode,
    status: 'success',
    response: message,
    ...(data ?? {})
  } as PublicSuccessPayload);
}

export function sendPublicError(response: Response, statusCode: number, message: string): Response {
  return response.status(statusCode).json({
    code: statusCode,
    status: 'failed',
    response: message
  } satisfies PublicErrorPayload);
}

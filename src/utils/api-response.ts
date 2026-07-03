import type { Response } from 'express';

export function sendSuccess<T>(response: Response, statusCode: number, data: T): Response {
  return response.status(statusCode).json({
    success: true,
    data
  });
}

export function sendEmptySuccess(response: Response, statusCode: number): Response {
  return response.status(statusCode).json({
    success: true
  });
}

import path from 'node:path';

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

const DOCUMENT_MIME_PREFIXES = ['application/', 'text/'];

export function detectMediaKind(mimeType: string): MediaKind | undefined {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }

  if (DOCUMENT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return 'document';
  }

  return undefined;
}

export function extensionForMimeType(mimeType: string): string {
  const subtype = mimeType.split('/')[1] ?? 'bin';
  const normalized = subtype.replace(/[^a-z0-9.+-]/gi, '_');

  return path.extname(`file.${normalized}`) || '.bin';
}

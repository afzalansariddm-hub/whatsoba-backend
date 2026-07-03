import { mkdirSync } from 'node:fs';
import path from 'node:path';

import multer from 'multer';

import { MEDIA_DIRECTORY } from '../config/media';
import { detectMediaKind } from '../utils/media-types';
import { AppError } from '../utils/app-error';

mkdirSync(MEDIA_DIRECTORY, { recursive: true });

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => {
    callback(null, MEDIA_DIRECTORY);
  },
  filename: (_request, file, callback) => {
    const extension = path.extname(file.originalname) || `.${file.mimetype.split('/')[1] ?? 'bin'}`;
    const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;

    callback(null, filename);
  }
});

export const uploadMedia = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024
  },
  fileFilter: (_request, file, callback) => {
    if (!detectMediaKind(file.mimetype)) {
      callback(new AppError('Unsupported media type', 415));
      return;
    }

    callback(null, true);
  }
});

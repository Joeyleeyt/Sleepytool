import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2, R2_BUCKET } from './r2.js';

export async function signGet(
  key: string,
  expiresInSeconds = 3600,
  opts: { downloadAs?: string } = {},
): Promise<string> {
  // When `downloadAs` is provided, R2 echoes back a Content-Disposition header
  // on the response so browsers save the file instead of opening it inline.
  const responseContentDisposition = opts.downloadAs
    ? `attachment; filename="${opts.downloadAs.replace(/"/g, '')}"`
    : undefined;
  return getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, ResponseContentDisposition: responseContentDisposition }),
    { expiresIn: expiresInSeconds },
  );
}

export async function signPut(key: string, contentType: string, expiresInSeconds = 900): Promise<string> {
  return getSignedUrl(r2, new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType }), {
    expiresIn: expiresInSeconds,
  });
}

import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const accountId = process.env.R2_ACCOUNT_ID ?? '';
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? '';
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? '';
export const R2_BUCKET = process.env.R2_BUCKET ?? 'emberforge-dev';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

export async function uploadFile(localPath: string, key: string, contentType?: string): Promise<{ key: string; bytes: number }> {
  const body = createReadStream(localPath);
  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  });
  await r2.send(cmd);
  const head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  return { key, bytes: head.ContentLength ?? 0 };
}

export async function uploadBuffer(buf: Buffer, key: string, contentType?: string) {
  await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buf, ContentType: contentType }));
  return { key, bytes: buf.byteLength };
}

export async function downloadToFile(key: string, localPath: string): Promise<void> {
  const res = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const body = res.Body as Readable;
  await pipeline(body, createWriteStream(localPath));
}

export async function exists(key: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

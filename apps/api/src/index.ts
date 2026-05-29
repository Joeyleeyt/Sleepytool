import { buildServer } from './server.js';

const port = Number(process.env.PORT ?? 8080);

const app = await buildServer();
await app.listen({ host: '0.0.0.0', port });
app.log.info({ port }, 'emberforge api listening');

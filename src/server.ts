import { createGguiServer } from '@ggui-ai/mcp-server';
import { createCliGenerationDeps } from './generator.js';
import type { CliGeneratorOptions } from './types.js';

export interface StartAddonServerOptions extends CliGeneratorOptions {
  readonly host?: string;
  readonly port?: number;
  readonly publicBaseUrl?: string;
}

export async function startAddonServer(options: StartAddonServerOptions) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 6781;
  const publicBaseUrl = options.publicBaseUrl ?? defaultPublicBaseUrl(host, port);
  const generation = createCliGenerationDeps(options);

  const server = createGguiServer({
    publicBaseUrl,
    sessionChannel: true,
    mcpApps: {
      wsUrl: toWsUrl(publicBaseUrl),
    },
    generation,
  });
  const httpServer = await server.listen(port, host);
  return {
    server,
    httpServer,
    host,
    port,
    publicBaseUrl,
    mcpUrl: `${publicBaseUrl.replace(/\/$/, '')}/mcp`,
  };
}

function defaultPublicBaseUrl(host: string, port: number): string {
  const urlHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return `http://${urlHost}:${port}`;
}

function toWsUrl(publicBaseUrl: string): string {
  const url = new URL(publicBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

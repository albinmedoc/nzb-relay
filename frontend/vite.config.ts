import { Buffer } from 'node:buffer';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

interface BasicAuthCredentials {
  username: string;
  password: string;
}

const AUTH_REALM = 'Basic realm="nzb-relay", charset="UTF-8"';
const allowedHost = process.env.FRONTEND_ALLOWED_HOST?.trim();

export default defineConfig({
  ...(allowedHost ? { preview: { allowedHosts: [allowedHost] } } : {}),
  plugins: [runtimeConfigPlugin(), vue()]
});

function runtimeConfigPlugin(): Plugin {
  return {
    name: 'nzb-relay-runtime-config',
    configureServer(server) {
      server.middlewares.use(runtimeConfigMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(runtimeConfigMiddleware);
    }
  };
}

function runtimeConfigMiddleware(
  request: { url?: string; headers: { authorization?: string | string[] } },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  },
  next: () => void
): void {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;

  if (path === '/health') {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('ok');
    return;
  }

  if (path === '/logout') {
    response.statusCode = 401;
    response.setHeader('www-authenticate', AUTH_REALM);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('Logged out');
    return;
  }

  const credentials = parseBasicAuth(request.headers.authorization);
  if (!credentials?.password) {
    response.statusCode = 401;
    response.setHeader('www-authenticate', AUTH_REALM);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end('Authentication required');
    return;
  }

  if (path === '/config.js') {
    response.statusCode = 200;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/javascript; charset=utf-8');
    response.end(`window.NZB_RELAY_CONFIG = ${JSON.stringify({
      backendUrl: credentials.username,
      token: credentials.password
    })};`);
    return;
  }

  next();
}

function parseBasicAuth(header: string | string[] | undefined): BasicAuthCredentials | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Basic ')) {
    return null;
  }

  const decoded = Buffer.from(value.slice('Basic '.length), 'base64').toString('utf8');
  const splitAt = decoded.startsWith('http://') || decoded.startsWith('https://')
    ? decoded.lastIndexOf(':')
    : decoded.indexOf(':');
  if (splitAt < 0) {
    return null;
  }

  return {
    username: decodeUserInfo(decoded.slice(0, splitAt)).trim(),
    password: decodeUserInfo(decoded.slice(splitAt + 1)).trim()
  };
}

function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    base: '/geminilive/',
    server: {
      port: 3000,
      host: '0.0.0.0',
      proxy: {
        // Relay /mcp requests to the Tailscale HTTPS server
        '/mcp': {
          target: 'https://agentzero.tail335dec.ts.net',
          changeOrigin: true,
          secure: false,
          ws: true, // Support persistent connections
          configure: (proxy, _options) => {
            proxy.on('proxyRes', (proxyRes, req, _res) => {
              // Disable buffering for SSE to work correctly
              proxyRes.headers['x-accel-buffering'] = 'no';
              proxyRes.headers['cache-control'] = 'no-cache';
              proxyRes.headers['access-control-allow-origin'] = '*';
              proxyRes.headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
              proxyRes.headers['access-control-allow-headers'] = 'Content-Type, Authorization';
            });
          },
        }
      }
    },
    plugins: [react()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(process.cwd(), '.'),
      }
    }
  };
});
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev too, so cookies and sockets behave exactly as they
    // will in production behind Caddy.
    // 127.0.0.1, not localhost: on Windows "localhost" resolves to ::1 first,
    // and the API binds IPv4, so the proxy would hang waiting on IPv6.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/socket.io': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});

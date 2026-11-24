import { defineConfig } from 'vite';

const apiPort = Number(process.env.OFI_PORT || 4317);
const clientPort = Number(process.env.OFI_CLIENT_PORT || 5173);

export default defineConfig({
  root: 'src/client',
  publicDir: false,
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    host: '127.0.0.1',
    port: clientPort,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false
      },
      '/ws': {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true
      }
    }
  }
});

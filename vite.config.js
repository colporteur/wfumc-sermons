import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Set BASE_PATH in your build env to match the GitHub Pages repo path,
// e.g. "/wfumc-sermons/". Defaults to "/" for local dev.
const base = process.env.VITE_BASE_PATH || '/';

// Build-time stamp injected into the bundle so we can render a tiny
// version marker at the bottom of every page. Lets us answer
// "is the new version actually deployed?" at a glance.
const buildTime = new Date().toISOString();
const buildSha = (process.env.GITHUB_SHA || 'local').slice(0, 7);

export default defineConfig({
  base,
  define: {
    __BUILD_TIME__: JSON.stringify(buildTime),
    __BUILD_SHA__: JSON.stringify(buildSha),
  },
  plugins: [react()],
  server: {
    port: 5174, // different default port from the bulletin app to avoid conflicts
  },
});

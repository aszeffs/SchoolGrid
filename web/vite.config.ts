import { defineConfig } from "vite";

export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic" },
  },
  build: {
    // Every script and stylesheet is emitted as a file of its own. The server's
    // Content Security Policy allows only same-origin files, with no exception
    // for inline code, and a file inlined as a `data:` URL is inline code too.
    assetsInlineLimit: 0,
    // The polyfill is for browsers without module preload, which the app does
    // not support; left in, it is code shipped for nothing.
    modulePreload: { polyfill: false },
  },
  server: {
    // In development Vite serves the page and the service serves the API.
    // Proxied, they share one origin, as they do when the image serves both.
    // Set PUBLIC_ORIGIN to Vite's origin, so a change made with the cookie
    // passes the Origin check.
    proxy: { "/api": "http://localhost:3000" },
  },
});

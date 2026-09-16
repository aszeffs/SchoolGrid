import { defineConfig, type Plugin } from "vite";

export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic" },
  },
  plugins: [noInlineCode()],
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

/**
 * Fails the build if a page it emits carries an inline script, stylesheet,
 * style attribute or event handler. The Content Security Policy would block
 * each of them in the browser, and a page that only breaks there is found late.
 * The browser suite reports violations on the pages it opens; this covers
 * every page, including ones no test opens.
 */
function noInlineCode(): Plugin {
  const INLINE = [
    { pattern: /<script\b(?![^>]*\bsrc=)[^>]*>/i, what: "an inline script" },
    { pattern: /<style\b/i, what: "an inline stylesheet" },
    { pattern: /\sstyle\s*=/i, what: "a style attribute" },
    { pattern: /\son[a-z]+\s*=/i, what: "an inline event handler" },
  ];
  return {
    name: "schoolgrid:no-inline-code",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "asset" || !output.fileName.endsWith(".html")) {
          continue;
        }
        const html = String(output.source);
        for (const { pattern, what } of INLINE) {
          if (pattern.test(html)) {
            this.error(`${output.fileName} contains ${what}, which the Content Security Policy blocks`);
          }
        }
      }
    },
  };
}

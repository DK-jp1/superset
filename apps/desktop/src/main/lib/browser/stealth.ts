// Stealth profile for the embedded <webview> browser ("ブラウザAI").
//
// Why: Electron's default Chromium leaks "I am automation" signals through
//   navigator.webdriver, navigator.plugins, missing window.chrome, the
//   "Electron/<ver>" UA, etc. This makes Cloudflare Turnstile, reCAPTCHA v3
//   and similar bot-detection front-ends throw their "Are you a robot?"
//   challenge on virtually every navigation, and never let the user through.
//
// Approach (loosely modelled on Scrapling / Patchright / puppeteer-stealth):
//   1. Pretend to be vanilla Chrome stable on macOS (CHROME_UA).
//   2. Patch the renderer JS environment so the most common bot-detection
//      checks return values that match a real desktop Chrome.
//
// Update CHROME_UA roughly once a month so the version doesn't drift far
// from real Chrome stable - an ancient UA is itself a red flag.

export const CHROME_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Injected into every webview frame on did-start-navigation. Kept as a single
// IIFE string so it can be passed straight to webContents.executeJavaScript.
// All patches are idempotent and guarded against double-application.
export const STEALTH_INIT_SCRIPT = String.raw`(() => {
  if (window.__supersetStealthApplied) return;
  Object.defineProperty(window, '__supersetStealthApplied', {
    value: true, configurable: false, enumerable: false, writable: false,
  });

  const nativeToString = Function.prototype.toString;
  const patched = new WeakSet();
  const markNative = (fn) => { try { patched.add(fn); } catch {} return fn; };
  const proxiedToString = new Proxy(nativeToString, {
    apply(target, thisArg, args) {
      if (patched.has(thisArg)) {
        return 'function ' + (thisArg.name || '') + '() { [native code] }';
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
  // The proxy itself must report as native, otherwise detectors that call
  // Function.prototype.toString.toString() see a Proxy wrapper.
  try { patched.add(proxiedToString); } catch {}
  Function.prototype.toString = proxiedToString;

  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: markNative(function () { return undefined; }),
      configurable: true, enumerable: true,
    });
  } catch {}

  try {
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: markNative(function () { return ['en-US', 'en']; }),
      configurable: true, enumerable: true,
    });
  } catch {}

  try {
    const fakePlugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ];
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get: markNative(function () { return fakePlugins; }),
      configurable: true, enumerable: true,
    });
    Object.defineProperty(Navigator.prototype, 'mimeTypes', {
      get: markNative(function () { return [{ type: 'application/pdf', suffixes: 'pdf', description: '' }]; }),
      configurable: true, enumerable: true,
    });
  } catch {}

  try {
    if (!window.chrome) {
      const t0 = (typeof performance !== 'undefined' ? performance.timeOrigin : Date.now()) / 1000;
      Object.defineProperty(window, 'chrome', {
        value: {
          runtime: {},
          app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
          // Datadome and similar bot vendors call csi()/loadTimes() and read
          // specific shaped objects, so return realistic-looking values rather
          // than empty {}.
          loadTimes: markNative(function () {
            return {
              requestTime: t0,
              startLoadTime: t0,
              commitLoadTime: t0,
              finishDocumentLoadTime: t0,
              finishLoadTime: t0,
              firstPaintTime: t0,
              firstPaintAfterLoadTime: 0,
              navigationType: 'Other',
              wasFetchedViaSpdy: true,
              wasNpnNegotiated: true,
              npnNegotiatedProtocol: 'h2',
              wasAlternateProtocolAvailable: false,
              connectionInfo: 'h2',
            };
          }),
          csi: markNative(function () {
            const now = Date.now();
            return {
              startE: now,
              onloadT: now,
              pageT: (typeof performance !== 'undefined' ? performance.now() : 0),
              tran: 15,
            };
          }),
        },
        configurable: true, enumerable: true, writable: true,
      });
    }
  } catch {}

  try {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = markNative(function (parameters) {
        if (parameters && parameters.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, name: 'notifications', onchange: null });
        }
        return originalQuery.call(window.navigator.permissions, parameters);
      });
    }
  } catch {}

  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = markNative(function (parameter) {
      // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    });
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = markNative(function (parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter2.call(this, parameter);
      });
    }
  } catch {}

  // Per-pixel low-amplitude noise on Canvas so fingerprint hashes vary
  // between sessions without breaking visible rendering.
  try {
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = markNative(function (...args) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          const data = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < data.data.length; i += 4) {
            data.data[i]     ^= 1;
            data.data[i + 1] ^= 1;
            data.data[i + 2] ^= 1;
          }
          ctx.putImageData(data, 0, 0);
        }
      } catch {}
      return toDataURL.apply(this, args);
    });
  } catch {}

  try {
    if (typeof AnalyserNode !== 'undefined') {
      const orig = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = markNative(function (array) {
        orig.call(this, array);
        for (let i = 0; i < array.length; i++) array[i] += Math.random() * 1e-7;
      });
    }
  } catch {}
})();`;

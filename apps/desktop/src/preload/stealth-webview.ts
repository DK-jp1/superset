// Webview-side stealth preload.
//
// Why a SEPARATE preload (not the main-window preload):
//   The main window's preload talks to Electron (ipcRenderer, contextBridge,
//   trpc). Webviews host arbitrary third-party sites and must NOT see any
//   Electron API surface. This file is a pure renderer script — no Electron
//   imports, no Node APIs — so it's safe to attach to every browsing context
//   via session.setPreloads("persist:superset", [...]).
//
// Why preload (not webContents.executeJavaScript on dom-ready):
//   Cloudflare Turnstile and similar bot managers run their fingerprinting
//   from <head> inline scripts, which execute BEFORE the dom-ready event.
//   Preload scripts run at document_start — they finish before the very
//   first byte of page HTML is parsed — so our patches are in place when
//   any page JS first reads navigator.webdriver, window.chrome, etc.
//
// Keep this file functionally identical to STEALTH_INIT_SCRIPT in
// main/lib/browser/stealth.ts. The dom-ready injection there is kept as a
// belt-and-suspenders fallback (the __supersetStealthApplied guard makes
// double-application a no-op).

(() => {
	const w = window as unknown as { __supersetStealthApplied?: boolean };
	if (w.__supersetStealthApplied) return;
	Object.defineProperty(window, "__supersetStealthApplied", {
		value: true,
		configurable: false,
		enumerable: false,
		writable: false,
	});

	const nativeToString = Function.prototype.toString;
	const patched = new WeakSet<object>();
	const markNative = <T extends object>(fn: T): T => {
		try {
			patched.add(fn);
		} catch {}
		return fn;
	};
	const proxiedToString = new Proxy(nativeToString, {
		apply(target, thisArg: object, args: unknown[]) {
			if (thisArg && patched.has(thisArg as object)) {
				const name = (thisArg as { name?: string }).name ?? "";
				return `function ${name}() { [native code] }`;
			}
			return Reflect.apply(
				target,
				thisArg,
				args as Parameters<typeof target>,
			);
		},
	});
	try {
		patched.add(proxiedToString);
	} catch {}
	Function.prototype.toString = proxiedToString;

	try {
		Object.defineProperty(Navigator.prototype, "webdriver", {
			get: markNative(function () {
				return undefined;
			}),
			configurable: true,
			enumerable: true,
		});
	} catch {}

	try {
		Object.defineProperty(Navigator.prototype, "languages", {
			get: markNative(function () {
				return ["en-US", "en"];
			}),
			configurable: true,
			enumerable: true,
		});
	} catch {}

	try {
		const fakePlugins = [
			{
				name: "PDF Viewer",
				filename: "internal-pdf-viewer",
				description: "Portable Document Format",
			},
			{
				name: "Chrome PDF Viewer",
				filename: "internal-pdf-viewer",
				description: "Portable Document Format",
			},
			{
				name: "Chromium PDF Viewer",
				filename: "internal-pdf-viewer",
				description: "Portable Document Format",
			},
			{
				name: "Microsoft Edge PDF Viewer",
				filename: "internal-pdf-viewer",
				description: "Portable Document Format",
			},
			{
				name: "WebKit built-in PDF",
				filename: "internal-pdf-viewer",
				description: "Portable Document Format",
			},
		];
		Object.defineProperty(Navigator.prototype, "plugins", {
			get: markNative(function () {
				return fakePlugins;
			}),
			configurable: true,
			enumerable: true,
		});
		Object.defineProperty(Navigator.prototype, "mimeTypes", {
			get: markNative(function () {
				return [
					{ type: "application/pdf", suffixes: "pdf", description: "" },
				];
			}),
			configurable: true,
			enumerable: true,
		});
	} catch {}

	try {
		if (!(window as unknown as { chrome?: unknown }).chrome) {
			const t0 =
				(typeof performance !== "undefined"
					? performance.timeOrigin
					: Date.now()) / 1000;
			Object.defineProperty(window, "chrome", {
				value: {
					runtime: {},
					app: {
						isInstalled: false,
						InstallState: {
							DISABLED: "disabled",
							INSTALLED: "installed",
							NOT_INSTALLED: "not_installed",
						},
						RunningState: {
							CANNOT_RUN: "cannot_run",
							READY_TO_RUN: "ready_to_run",
							RUNNING: "running",
						},
					},
					loadTimes: markNative(function () {
						return {
							requestTime: t0,
							startLoadTime: t0,
							commitLoadTime: t0,
							finishDocumentLoadTime: t0,
							finishLoadTime: t0,
							firstPaintTime: t0,
							firstPaintAfterLoadTime: 0,
							navigationType: "Other",
							wasFetchedViaSpdy: true,
							wasNpnNegotiated: true,
							npnNegotiatedProtocol: "h2",
							wasAlternateProtocolAvailable: false,
							connectionInfo: "h2",
						};
					}),
					csi: markNative(function () {
						const now = Date.now();
						return {
							startE: now,
							onloadT: now,
							pageT:
								typeof performance !== "undefined"
									? performance.now()
									: 0,
							tran: 15,
						};
					}),
				},
				configurable: true,
				enumerable: true,
				writable: true,
			});
		}
	} catch {}

	try {
		const perms = (window as unknown as { navigator: Navigator }).navigator
			.permissions;
		const originalQuery = perms?.query;
		if (originalQuery) {
			perms.query = markNative(function (
				parameters: PermissionDescriptor,
			) {
				if (parameters && parameters.name === "notifications") {
					return Promise.resolve({
						state: Notification.permission,
						name: "notifications",
						onchange: null,
					} as PermissionStatus);
				}
				return originalQuery.call(perms, parameters);
			}) as typeof originalQuery;
		}
	} catch {}

	try {
		const getParameter = WebGLRenderingContext.prototype.getParameter;
		WebGLRenderingContext.prototype.getParameter = markNative(function (
			this: WebGLRenderingContext,
			parameter: GLenum,
		) {
			if (parameter === 37445) return "Intel Inc.";
			if (parameter === 37446) return "Intel Iris OpenGL Engine";
			return getParameter.call(this, parameter);
		}) as typeof getParameter;
		if (typeof WebGL2RenderingContext !== "undefined") {
			const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
			WebGL2RenderingContext.prototype.getParameter = markNative(function (
				this: WebGL2RenderingContext,
				parameter: GLenum,
			) {
				if (parameter === 37445) return "Intel Inc.";
				if (parameter === 37446) return "Intel Iris OpenGL Engine";
				return getParameter2.call(this, parameter);
			}) as typeof getParameter2;
		}
	} catch {}

	try {
		const toDataURL = HTMLCanvasElement.prototype.toDataURL;
		HTMLCanvasElement.prototype.toDataURL = markNative(function (
			this: HTMLCanvasElement,
			...args: Parameters<typeof toDataURL>
		) {
			try {
				const ctx = this.getContext("2d");
				if (ctx && this.width > 0 && this.height > 0) {
					const data = ctx.getImageData(0, 0, this.width, this.height);
					for (let i = 0; i < data.data.length; i += 4) {
						data.data[i] ^= 1;
						data.data[i + 1] ^= 1;
						data.data[i + 2] ^= 1;
					}
					ctx.putImageData(data, 0, 0);
				}
			} catch {}
			return toDataURL.apply(this, args);
		}) as typeof toDataURL;
	} catch {}

	try {
		if (typeof AnalyserNode !== "undefined") {
			const orig = AnalyserNode.prototype.getFloatFrequencyData;
			type GetFloatFrequencyDataArg = Parameters<typeof orig>[0];
			AnalyserNode.prototype.getFloatFrequencyData = markNative(function (
				this: AnalyserNode,
				array: GetFloatFrequencyDataArg,
			) {
				orig.call(this, array);
				for (let i = 0; i < array.length; i++)
					array[i] += Math.random() * 1e-7;
			}) as typeof orig;
		}
	} catch {}
})();

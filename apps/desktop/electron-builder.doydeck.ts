/**
 * Electron Builder Configuration - DoyDeck local app build.
 *
 * This keeps the packaged DoyDeck.app separate from the regular Superset.app.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Configuration } from "electron-builder";
import baseConfig from "./electron-builder";
import pkg from "./package.json";

const productName = "DoyDeck";
const macIconPath = join(pkg.resources, "build/icons/icon.icns");
const linuxIconPath = join(pkg.resources, "build/icons");
const winIconPath = join(pkg.resources, "build/icons/icon.ico");

const config: Configuration = {
	...baseConfig,
	appId: "com.doydeck.desktop",
	productName,
	generateUpdatesFilesForAllChannels: false,
	publish: null,
	directories: {
		...baseConfig.directories,
		output: "release-doydeck",
	},
	extraMetadata: {
		main: "./dist/main/doydeck-bootstrap.js",
		name: "doydeck",
		productName,
	},
	mac: {
		...baseConfig.mac,
		...(existsSync(macIconPath) ? { icon: macIconPath } : {}),
		target: ["dir", "dmg"],
		artifactName: `DoyDeck-\${version}-\${arch}.\${ext}`,
		hardenedRuntime: false,
		notarize: false,
		identity: null,
		extendInfo: {
			...baseConfig.mac?.extendInfo,
			CFBundleName: productName,
			CFBundleDisplayName: productName,
			CFBundleIdentifier: "com.doydeck.desktop",
		},
	},
	dmg: {
		...baseConfig.dmg,
		artifactName: `DoyDeck-\${version}-\${arch}.dmg`,
		title: productName,
	},
	protocols: {
		name: productName,
		schemes: ["doydeck", "superset-doydeck-dev"],
	},
	linux: {
		...baseConfig.linux,
		...(existsSync(linuxIconPath) ? { icon: linuxIconPath } : {}),
		synopsis: `${pkg.description} (DoyDeck)`,
		artifactName: `DoyDeck-\${version}-\${arch}.\${ext}`,
	},
	win: {
		...baseConfig.win,
		...(existsSync(winIconPath) ? { icon: winIconPath } : {}),
		artifactName: `DoyDeck-\${version}-\${arch}.\${ext}`,
	},
};

export default config;

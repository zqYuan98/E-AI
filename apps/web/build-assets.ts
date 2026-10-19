// Anonymous resources come from the browser bundle, never from files copied out of public/.
import type { Plugin } from "vite";

export const ASSET_LIST = ".access-assets.json";

export function accessAssets(): Plugin {
  return {
    name: "access-build-assets",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        if (this.environment.name !== "client") return;
        const files = Object.keys(bundle).filter(name => !name.startsWith(".") && !name.endsWith(".map"));
        this.emitFile({ type: "asset", fileName: ASSET_LIST, source: JSON.stringify(files.map(name => `/${name}`).sort()) });
      },
    },
  };
}

import { plugin } from "./plugin";
import recommendedConfig from "./configs/recommended";
import typescriptConfig from "./configs/typescript";

// Use the Config type for the recommended config
const pluginLegacy = {
  rules: plugin.rules,
  configs: {
    recommended: {
      plugins: ["solid"],
      env: {
        browser: true,
        es6: true,
      },
      parserOptions: recommendedConfig.languageOptions.parserOptions,
      rules: recommendedConfig.rules,
    },
    typescript: {
      plugins: ["solid"],
      env: {
        browser: true,
        es6: true,
      },
      parserOptions: {
        sourceType: "module",
      },
      rules: typescriptConfig.rules,
    },
  },
};

export default pluginLegacy;
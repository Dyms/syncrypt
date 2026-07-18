import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js", "**/*.mjs"],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // RFC-0007: no non-null assertions without cause — forbid them outright;
      // justified cases get a targeted eslint-disable with a comment.
      "@typescript-eslint/no-non-null-assertion": "error",
      // The port boundary is Promise-based end to end.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
      // Manifests are Record<VaultPath, …> maps by design (RFC-0007 §1);
      // removing a path from them is normal, not a code smell.
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Root config files sit outside the package tsconfigs; lint them untyped.
    files: ["*.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

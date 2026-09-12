// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Generated Prisma client and build output are not ours to lint.
    ignores: ["dist/**", "src/generated/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused variables are a real signal, but an underscore prefix is the
      // conventional way to say "required by the signature, deliberately
      // unused" -- which Express middleware does constantly.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Tests assert on loosely-typed JSON response bodies; demanding a type
      // for every one of those would add noise without adding safety.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);

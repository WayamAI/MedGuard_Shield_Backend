// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  {
    // Generated Prisma client and build output are not ours to lint.
    ignores: ["dist/**", "src/generated/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    rules: {
      // This codebase's one dynamic require (pino-http's CJS/ESM interop
      // workaround in src/middleware/logging.ts) is a fixed, hardcoded
      // string, not attacker-reachable input -- the rule's actual concern
      // (requiring a value built from user input) does not apply there.
      "security/detect-non-literal-require": "off",
      // Famously high-noise: flags ordinary bracket-notation property
      // access on internal, non-attacker-controlled data (Prisma results,
      // fixed label arrays, this file's own constants) as a potential
      // injection sink. A real pass over all ~60 hits in this codebase
      // found none where the key came from request input; every
      // genuinely risky case (the two non-literal-regexp/fs-filename
      // instances below) is suppressed individually with its own
      // justification instead, which keeps the signal visible there.
      "security/detect-object-injection": "off",
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

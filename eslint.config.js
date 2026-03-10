import { FlatCompat } from "@eslint/eslintrc";
import { fileURLToPath } from "url";
import { dirname } from "path";
import tsParser from "@typescript-eslint/parser"; // <-- import the parser

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: true
});

export default [
    // ESLint recommended rules
    ...compat.extends("eslint:recommended"),

    // TypeScript recommended rules
    ...compat.extends("plugin:@typescript-eslint/recommended"),

    // Prettier integration
    ...compat.extends("plugin:prettier/recommended"),
    // Ignore specific files and folders
    {
        ignores: [
            "src/playground.ts",
            "src/workflow1.ts",
            "src/__tests__/**",
            "dist/**",
            "node_modules/**",
            "examples/**",
            "src/examples/**",
            "docs/**",
            "coverage-local/**",
            "scripts/**"
        ]
    },
    {
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2020,
                sourceType: "module",
                project: "./tsconfig.json"
            }
        },
        files: ["src/**/*.ts"], // only lint source + test files
        rules: {
            "@typescript-eslint/explicit-function-return-type": "off",
            "@typescript-eslint/no-explicit-any": "off", // disable rule completely
            "prettier/prettier": [
                "error",
                {
                    printWidth: 128,
                    semi: true,
                    singleQuote: false,
                    tabWidth: 4,
                    trailingComma: "none",
                    endOfLine: "lf", // keep line endings consistent (optional)
                    insertFinalNewline: true
                }
            ],
            // allow unused params starting with _
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_", // <-- ignore params starting with underscore
                    varsIgnorePattern: "^_", // optional: ignore variables starting with underscore
                    caughtErrorsIgnorePattern: "^_" // optional: ignore catch params starting with underscore
                }
            ],
            curly: ["error", "all"], // Enforce consistent brace style for all control statements
            "eol-last": ["error", "always"] // Require newline at EOF
        }
    }
];

import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "#root": path.resolve(__dirname, "src")
        }
    },
    test: {
        globals: true,
        silent: true,
        environment: "node",
        setupFiles: ["src/__tests__/setupTests.ts"],
        coverage: {
            provider: "istanbul",
            reporter: ["text", "lcov"],
            include: ["src/**/*.ts"],
            exclude: ["src/__tests__/**", "src/playground.ts"]
        }
    }
});

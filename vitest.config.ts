import path from "path";
import { defineConfig } from "vitest/config";

const coverageDir = process.env.COVERAGE_DIR ?? (process.env.CI ? "coverage-ci" : "coverage-local");

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
        setupFiles: "src/__tests__/setupTests.ts",
        coverage: {
            clean: false,
            reportsDirectory: coverageDir,
            cleanOnRerun: true,
            provider: "istanbul",
            reporter: ["text", "lcov"],
            include: ["src/**/*.ts"],
            exclude: ["src/__tests__/**", "src/playground.ts", "src/job1.ts", "src/job2.ts"]
        }
    }
});

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
        environment: "node",
        silent: false,
        testTimeout: 60000,
        include: ["src/__tests__/integration/**/*.test.ts"]
    }
});

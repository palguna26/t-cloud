import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations/drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://localhost/termyte" },
});

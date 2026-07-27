import { z } from "zod";

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  AGENT_TOKEN_PEPPER: z.string().min(32),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  DEMO_USER_ID: z.string().uuid().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  CONNECTOR_ENCRYPTION_KEY: z.string().optional(),
  CONTEXT_SYNTHESIS_BASE_URL: z.string().url().optional(),
  CONTEXT_SYNTHESIS_API_KEY: z.string().min(1).optional(),
  CONTEXT_SYNTHESIS_MODEL: z.string().min(1).optional(),
  CONTEXT_SYNTHESIS_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(5_000),
  CLOUDFLARE_AI_ACCOUNT_URL: z.string().url().optional(),
  CLOUDFLARE_AI_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_AI_MODEL: z.string().min(1).optional(),
  EXTRACTION_VERSION: z.string().min(1).default("gemma-4-27b-v1"),
  GITHUB_APP_SLUG: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),
  SLACK_CLIENT_ID: z.string().min(1).optional(),
  SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  SLACK_SIGNING_SECRET: z.string().min(16).optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return ConfigSchema.parse(env);
}

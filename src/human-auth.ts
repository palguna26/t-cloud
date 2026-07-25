export interface HumanPrincipal {
  userId: string;
}

export type HumanAuthenticator = (token: string) => Promise<HumanPrincipal | null>;

export function createSupabaseHumanAuthenticator(
  supabaseUrl: string,
  anonKey: string,
  fetcher: typeof fetch = fetch,
): HumanAuthenticator {
  return async (token) => {
    try {
      const response = await fetcher(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
        headers: {
          authorization: `Bearer ${token}`,
          apikey: anonKey,
        },
      });
      if (!response.ok) return null;
      const body = await response.json() as { id?: unknown };
      return typeof body.id === "string" && body.id ? { userId: body.id } : null;
    } catch {
      return null;
    }
  };
}

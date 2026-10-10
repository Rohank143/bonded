// The project's own file named bonded.ts: init must not write over it, or import from it.
export const bondedApiUrl = process.env.BONDED_API_URL ?? "https://api.example.com";

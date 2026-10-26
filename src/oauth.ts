// Generic OAuth 2.0 Device Authorization Grant (RFC 8628), config-driven so it works
// with any provider that supports device flow — beyond the existing Codex/ChatGPT OAuth.
type Json = Record<string, unknown>;

export type DeviceFlowConfig = {
  deviceAuthEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope?: string;
  clientSecret?: string;
};

export type DeviceAuth = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
};

export function deviceAuthRequest(cfg: DeviceFlowConfig): { url: string; body: string } {
  const body = new URLSearchParams({ client_id: cfg.clientId });
  if (cfg.scope) body.set("scope", cfg.scope);
  return { url: cfg.deviceAuthEndpoint, body: body.toString() };
}

export function tokenPollRequest(cfg: DeviceFlowConfig, deviceCode: string): { url: string; body: string } {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  return { url: cfg.tokenEndpoint, body: body.toString() };
}

export function parseDeviceAuth(j: Json): DeviceAuth {
  return {
    device_code: String(j.device_code ?? ""),
    user_code: String(j.user_code ?? ""),
    verification_uri: String(j.verification_uri ?? j.verification_url ?? ""),
    verification_uri_complete: j.verification_uri_complete ? String(j.verification_uri_complete) : undefined,
    interval: Number(j.interval ?? 5),
    expires_in: Number(j.expires_in ?? 900),
  };
}

export type PollResult = { token?: string; pending?: boolean; slowDown?: boolean; error?: string };
export function parseTokenResponse(j: Json): PollResult {
  if (typeof j.access_token === "string") return { token: j.access_token };
  const err = String(j.error ?? "");
  if (err === "authorization_pending") return { pending: true };
  if (err === "slow_down") return { slowDown: true };
  return { error: err || "unknown_error" };
}

type FetchResponse = { ok: boolean; status: number; json: () => Promise<Json>; text: () => Promise<string> };
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<FetchResponse>;

export async function runDeviceFlow(cfg: DeviceFlowConfig, opts: {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  onPrompt?: (auth: DeviceAuth) => void;
  maxAttempts?: number;
} = {}): Promise<string> {
  const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

  const da = deviceAuthRequest(cfg);
  const daRes = await doFetch(da.url, { method: "POST", headers, body: da.body });
  if (!daRes.ok) throw new Error(`device authorization failed: ${daRes.status} ${await daRes.text()}`);
  const auth = parseDeviceAuth(await daRes.json());
  if (!auth.device_code) throw new Error("no device_code in device authorization response");
  opts.onPrompt?.(auth);

  let interval = Math.max(auth.interval, 1);
  const maxAttempts = opts.maxAttempts ?? Math.ceil(auth.expires_in / interval);
  const poll = tokenPollRequest(cfg, auth.device_code);
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(interval * 1000);
    const res = await doFetch(poll.url, { method: "POST", headers, body: poll.body });
    const result = parseTokenResponse(await res.json());
    if (result.token) return result.token;
    if (result.slowDown) { interval += 5; continue; }
    if (result.pending) continue;
    throw new Error(`device flow error: ${result.error}`);
  }
  throw new Error("device flow timed out before authorization");
}

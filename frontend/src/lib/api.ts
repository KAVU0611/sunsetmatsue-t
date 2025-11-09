const DEFAULT_API_BASE = "https://3s9sgxfexe.execute-api.us-east-1.amazonaws.com/prod";
const RAW_BASE = (import.meta.env.VITE_API_URL ?? "").trim();
const BASE = (RAW_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
const METRICS_PATH = import.meta.env.VITE_METRICS_API || "/v1/sunset-index";
const IMAGE_PATH = import.meta.env.VITE_IMAGE_API || "/v1/generate-card";
const TIMEOUT_MS = 15_000;

type FetchOptions = RequestInit & { timeoutMs?: number };

function requireBaseUrl() {
  if (!BASE) {
    throw new Error("VITE_API_URL is not defined. Please configure frontend/.env.");
  }
}

async function doFetch<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as T) : (null as T);
    if (!response.ok) {
      const message = (data as any)?.message || `Request failed (${response.status})`;
      throw new Error(message);
    }
    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("リクエストがタイムアウトしました (15秒)");
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("予期せぬエラーが発生しました");
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface SunsetIndexResponse {
  score: number;
  sunsetTime?: string;
  metrics?: {
    weather?: string;
    clouds?: number;
    humidity?: number;
    pm25?: number;
  };
  breakdown?: unknown;
}

export interface SunsetIndexParams {
  lat: number;
  lon: number;
}

export interface GenerateCardPayload {
  location: string;
  date: string;
  conditions: string;
  score: number;
  sunsetTime: string;
  style: "simple" | "gradient";
  textSize: "md" | "lg";
}

export interface GenerateCardResponse {
  requestId?: string;
  imageUrl?: string;
  cloudFrontUrl?: string;
  s3Url?: string;
  objectKey?: string;
  sunsetJst?: string;
}

export async function getSunsetIndex(params: SunsetIndexParams) {
  requireBaseUrl();
  const qs = new URLSearchParams({
    lat: params.lat.toString(),
    lon: params.lon.toString()
  });
  return doFetch<SunsetIndexResponse>(`${BASE}${METRICS_PATH}?${qs.toString()}`, {
    method: "GET"
  });
}

export async function generateCard(payload: GenerateCardPayload) {
  requireBaseUrl();
  return doFetch<GenerateCardResponse>(`${BASE}${IMAGE_PATH}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export const apiConfig = {
  baseUrl: BASE,
  metricsPath: METRICS_PATH,
  imagePath: IMAGE_PATH
};

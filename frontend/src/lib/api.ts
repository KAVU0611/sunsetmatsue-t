const DEFAULT_API_BASE = "https://3s9sgxfexe.execute-api.us-east-1.amazonaws.com/prod";
const RAW_BASE = (import.meta.env.VITE_API_URL ?? "").trim();
const BASE = (RAW_BASE || DEFAULT_API_BASE).replace(/\/$/, "");
const METRICS_PATH = import.meta.env.VITE_METRICS_API || "/v1/sunset-index";
const IMAGE_PATH = import.meta.env.VITE_IMAGE_API || "/v1/generate-card";
const FORECAST_PATH = import.meta.env.VITE_FORECAST_API || "/v1/forecast/sunset";
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
  sunsetTimeIso?: string;
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

export interface SunsetForecastResponse {
  location: { lat: number; lon: number };
  sunset_jst: string;
  source: string;
  predicted?: {
    cloudCover_pct?: number;
    humidity_pct?: number;
    pm25_ugm3?: number;
  };
  hourly_timestamp?: string;
  cache_ttl_sec?: number;
}

export interface SunsetForecastParams {
  date?: string;
  lat?: number;
  lon?: number;
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

export async function getSunsetForecast(params: SunsetForecastParams = {}) {
  requireBaseUrl();
  const query = new URLSearchParams();
  if (params.date) {
    query.set("date", params.date);
  }
  if (typeof params.lat === "number") {
    query.set("lat", params.lat.toString());
  }
  if (typeof params.lon === "number") {
    query.set("lon", params.lon.toString());
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return doFetch<SunsetForecastResponse>(`${BASE}${FORECAST_PATH}${suffix}`, {
    method: "GET",
    cache: "no-store"
  });
}

export const apiConfig = {
  baseUrl: BASE,
  metricsPath: METRICS_PATH,
  imagePath: IMAGE_PATH,
  forecastPath: FORECAST_PATH
};

import {
  Camera,
  Cloud,
  Droplets,
  Download,
  MapPin,
  Share2,
  Sparkles,
  Sun,
  SunMedium
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { apiConfig, generateCard, getSunsetIndex, type GenerateCardResponse } from "../lib/api";
import { uiSamples } from "../lib/ui-samples";
import { cn } from "../lib/utils";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Spinner } from "./ui/spinner";

type DesignVariant = "simple" | "gradient";
type TextScale = "md" | "lg";
type GenerateResponse = {
  imageUrl: string;
  objectKey: string;
  sunsetJst?: string;
};

const FIXED_COORDS = { lat: 35.4690, lon: 133.0505 };
const FIXED_LOCATION_LABEL = "嫁ヶ島ビュー（35.4690, 133.0505）";
const spots = [
  {
    id: "yomegashima",
    name: FIXED_LOCATION_LABEL,
    lat: FIXED_COORDS.lat,
    lon: FIXED_COORDS.lon
  }
] as const;

const DEFAULT_SPOT = spots[0];
const DEFAULT_COORDS = { lat: DEFAULT_SPOT.lat, lon: DEFAULT_SPOT.lon };
const DEFAULT_IMAGE = uiSamples.length > 0 ? encodeURI(uiSamples[0]) : "";
const PLACEHOLDER_IMAGE = uiSamples[0] ?? "";
const todaysDate = new Date().toISOString().split("T")[0];
const CDN_BASE_URL = "https://matsuesunsetai.com";

interface Metrics {
  weather: string;
  clouds: number;
  humidity: number;
  pm25: number | null;
}

interface SunsetForecastResponse {
  location: { lat: number; lon: number };
  sunset_jst: string;
  source: string;
  predicted: {
    cloudCover_pct?: number;
    humidity_pct?: number;
    pm25_ugm3?: number;
  };
  hourly_timestamp?: string;
  cache_ttl_sec?: number;
}

export default function SunsetCard() {
  const [selectedSpotId, setSelectedSpotId] = useState<string>(DEFAULT_SPOT.id);
  const [location, setLocation] = useState(DEFAULT_SPOT.name);
  const [coords, setCoords] = useState(DEFAULT_COORDS);
  const [design, setDesign] = useState<DesignVariant>("gradient");
  const [textScale, setTextScale] = useState<TextScale>("md");
  const [score, setScore] = useState(50);
  const [sunsetScore, setSunsetScore] = useState<number | null>(null);
  const [sunsetTime, setSunsetTime] = useState("--:--");
  const [metricsTab, setMetricsTab] = useState<"current" | "forecast">("current");
  const [metrics, setMetrics] = useState<Metrics>({
    weather: "取得中…",
    clouds: 0,
    humidity: 0,
    pm25: null
  });
  const [forecast, setForecast] = useState<SunsetForecastResponse | null>(null);
  const [loadingForecast, setLoadingForecast] = useState(false);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState(DEFAULT_IMAGE);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);
  const [resp, setResp] = useState<GenerateResponse | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "error" | "success" } | null>(null);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null);

  const apiMissing = !apiConfig.baseUrl;
  const displaySunsetTime = forecast?.sunset_jst ? formatSunset(forecast.sunset_jst) : sunsetTime;
  const displayScore = clampScore(sunsetScore ?? score);
  const isForecastScore = sunsetScore !== null;
  const resolveImageUrl = (result: GenerateCardResponse) => {
    const preferredKey =
      result.objectKey ??
      deriveObjectKeyFromUrl(result.imageUrl) ??
      deriveObjectKeyFromUrl(result.cloudFrontUrl) ??
      deriveObjectKeyFromUrl(result.s3Url);
    return buildPublicImageUrl(preferredKey);
  };

  const handleImageError = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (!PLACEHOLDER_IMAGE) return;
    event.currentTarget.onerror = null;
    event.currentTarget.src = PLACEHOLDER_IMAGE;
  };

  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(() => setToast(null), 4800);
    return () => clearTimeout(handle);
  }, [toast]);

  useEffect(() => {
    const nextSpot = spots.find((spot) => spot.id === selectedSpotId) ?? DEFAULT_SPOT;
    setLocation(nextSpot.name);
    setCoords({ lat: nextSpot.lat, lon: nextSpot.lon });
  }, [selectedSpotId]);

  useEffect(() => {
    if (apiMissing) return;
    let cancelled = false;
    const load = async () => {
      setLoadingMetrics(true);
      try {
        const response = await getSunsetIndex(coords);
        if (cancelled) return;
        const nextScore = Math.min(100, Math.max(0, Math.round(response.score ?? 0)));
        const nextSunset = formatSunset(response.sunsetTime);
        setScore(nextScore);
        setSunsetTime(nextSunset);
        setMetrics({
          weather: response.metrics?.weather ?? "データ取得中",
          clouds: response.metrics?.clouds ?? 0,
          humidity: response.metrics?.humidity ?? 0,
          pm25: typeof response.metrics?.pm25 === "number" ? response.metrics?.pm25 : null
        });
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setToast({ message: "現在メンテナンス中 または通信に失敗しました", tone: "error" });
        }
      } finally {
        if (!cancelled) {
          setLoadingMetrics(false);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [coords, apiMissing]);

  useEffect(() => {
    if (apiMissing || !apiConfig.baseUrl) return;
    let cancelled = false;
    const fetchForecast = async () => {
      setLoadingForecast(true);
      setForecastError(null);
      try {
        const res = await fetch(`${apiConfig.baseUrl}/v1/forecast/sunset`, { cache: "no-store" });
        if (!res.ok) {
          throw new Error(`forecast fetch failed (${res.status})`);
        }
        const data: SunsetForecastResponse = await res.json();
        if (!cancelled) {
          setForecast(data);
          setSunsetScore(calculateSunsetScore(data.predicted));
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setForecastError("予報データを取得できませんでした");
          setSunsetScore(null);
        }
      } finally {
        if (!cancelled) {
          setLoadingForecast(false);
        }
      }
    };
    fetchForecast();
    return () => {
      cancelled = true;
    };
  }, [apiMissing]);

  const infoRow = useMemo(
    () => [
      { label: "観測地点", value: location, icon: <MapPin className="h-4 w-4 text-foreground/70" /> },
      {
        label: "夕日指数",
        value: `${displayScore} / 100`,
        icon: <Sun className="h-4 w-4 text-foreground/70" />
      },
      { label: "日の入り", value: displaySunsetTime, icon: <SunMedium className="h-4 w-4 text-foreground/70" /> }
    ],
    [location, displayScore, displaySunsetTime]
  );

  const currentMetricCards = [
    { label: "天気", value: metrics.weather, icon: <Sun className="h-4 w-4" /> },
    { label: "雲量", value: `${metrics.clouds}%`, icon: <Cloud className="h-4 w-4" /> },
    { label: "湿度", value: `${metrics.humidity}%`, icon: <Droplets className="h-4 w-4" /> },
    {
      label: "PM2.5",
      value: metrics.pm25 !== null ? `${metrics.pm25.toFixed(1)} µg/m³` : "観測中",
      icon: <Camera className="h-4 w-4" />
    }
  ];

  const forecastMetricCards = [
    { label: "雲量 (予測)", value: formatPercentOrPlaceholder(forecast?.predicted?.cloudCover_pct), icon: <Cloud className="h-4 w-4" /> },
    { label: "湿度 (予測)", value: formatPercentOrPlaceholder(forecast?.predicted?.humidity_pct), icon: <Droplets className="h-4 w-4" /> },
    {
      label: "PM2.5 (予測)",
      value: formatPmValue(forecast?.predicted?.pm25_ugm3),
      icon: <Camera className="h-4 w-4" />
    },
    {
      label: "日の入り予測",
      value: formatSunset(forecast?.sunset_jst),
      icon: <SunMedium className="h-4 w-4" />
    }
  ];

  const displayMetricCards = metricsTab === "forecast" ? forecastMetricCards : currentMetricCards;
  const forecastStatusText = loadingForecast ? (
    <span className="inline-flex items-center gap-2">
      <Spinner /> 予報データ取得中...
    </span>
  ) : forecastError ? (
    <span className="text-red-200">{forecastError}</span>
  ) : (
    <span>
      {forecast?.hourly_timestamp ? `最寄り時刻: ${formatForecastTimestamp(forecast.hourly_timestamp)}` : "最新データを取得済み"}
    </span>
  );

  const handleGenerate = async () => {
    if (apiMissing) {
      setToast({
        message: "frontend/.env に VITE_API_URL を設定してください。",
        tone: "error"
      });
      return;
    }
    setLoadingImage(true);
    try {
      const response = await generateCard({
        location,
        date: todaysDate,
        conditions: metrics.weather,
        score: displayScore,
        sunsetTime: displaySunsetTime,
        style: design,
        textSize: textScale
      });
      const nextUrl = resolveImageUrl(response);
      if (!nextUrl) {
        throw new Error("画像URLがレスポンスに含まれていません");
      }
      setPreviewUrl(nextUrl);
      setResp({
        imageUrl: nextUrl,
        objectKey: response.objectKey ?? deriveObjectKeyFromUrl(nextUrl) ?? "",
        sunsetJst: response.sunsetJst
      });
      setLastGeneratedAt(
        new Date().toLocaleTimeString("ja-JP", {
          hour: "2-digit",
          minute: "2-digit"
        })
      );
      setToast({ message: "カードを生成しました。", tone: "success" });
    } catch (error) {
      console.error(error);
      setToast({ message: "現在メンテナンス中 または通信に失敗しました", tone: "error" });
    } finally {
      setLoadingImage(false);
    }
  };

  const handleSaveImage = async () => {
    if (!previewUrl) return;
    try {
      await downloadCardImage(previewUrl);
      setToast({ message: "画像を保存しました。", tone: "success" });
    } catch (error) {
      console.error(error);
      setToast({ message: "画像を保存できませんでした", tone: "error" });
    }
  };

  const handleShareX = () => {
    if (!previewUrl) return;
    const text = `松江の夕日指数 ${displayScore}/100 ・日の入り ${displaySunsetTime}`;
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(
      previewUrl
    )}&hashtags=sunsetforecast`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center text-white">
        <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1 text-xs font-medium tracking-[0.2em] text-white/80">
          <Sparkles className="h-4 w-4 text-amber-300" />
          SUNSET CARD GENERATOR
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-white">夕日指数とAIカードをひと目で</h1>
        <p className="text-sm text-white/70">
          天気・雲量・湿度・PM2.5 から 0〜100 の夕日スコアを推定し、カード画像を生成します。
        </p>
      </div>

      {apiMissing && (
        <Alert className="bg-white/10 text-white">
          VITE_API_URL が未設定です。frontend/.env に
          <code className="mx-2 rounded bg-black/30 px-2 py-1">VITE_API_URL=https://3s9sgxfexe.execute-api.us-east-1.amazonaws.com/prod</code>
          を追加してください。
        </Alert>
      )}

      {toast && (
        <div
      className={cn(
        "rounded-2xl border px-4 py-3 text-sm shadow-card backdrop-blur",
        toast.tone === "error"
          ? "border-red-500/40 bg-red-500/10 text-red-100"
          : "border-emerald-400/40 bg-emerald-500/10 text-emerald-100"
      )}
    >
      {toast.message}
    </div>
  )}

      <div className="space-y-2">
        <p className="text-xs uppercase tracking-[0.4em] text-white/60">撮影スポット</p>
        <div className="flex gap-2 overflow-x-auto rounded-3xl border border-white/10 bg-white/5 p-2">
          {spots.map((spot) => {
            const active = spot.id === selectedSpotId;
            return (
              <button
                key={spot.id}
                type="button"
                onClick={() => setSelectedSpotId(spot.id)}
                className={cn(
                  "rounded-2xl px-4 py-2 text-sm transition",
                  active
                    ? "border-b-2 border-amber-300 font-semibold text-white"
                    : "text-white/70 hover:text-white"
                )}
              >
                {spot.name}
              </button>
            );
          })}
        </div>
      </div>

      <section className="rounded-glass border border-white/10 bg-card p-6 shadow-glass backdrop-blur">
        <div className="grid gap-8 lg:grid-cols-[1.25fr,0.75fr]">
          <article>
            <div className="space-y-4">
              <div className="rounded-[32px] border border-white/10 bg-gradient-to-br from-[#ff8f70] via-[#ff6a88] to-[#413b7b] p-1">
                <div className="relative overflow-hidden rounded-[30px] bg-black/60">
                  <div className="aspect-video w-full bg-black/40">
                    {previewUrl ? (
                      <img
                        src={previewUrl}
                        alt="sunset preview"
                        className="h-full w-full object-cover"
                        loading="lazy"
                        onError={handleImageError}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-white/60">サンプル画像を追加してください</div>
                    )}
                  </div>
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-6 pb-6 text-white",
                      textScale === "lg" ? "text-[1.15rem]" : "text-base"
                    )}
                  >
                    <div className="flex items-center justify-between text-sm text-white/80">
                      <span>{design === "gradient" ? "グラデーションカード" : "シンプルカード"}</span>
                      {lastGeneratedAt && <span>最終生成 {lastGeneratedAt}</span>}
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xl font-semibold leading-tight">{location}</p>
                        <p className="text-sm text-white/70">
                          Sunset Score {displayScore}/100
                          {isForecastScore && <span className="ml-2 text-xs">（日の入り予測）</span>}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-white/70">日の入り</p>
                        <p className={cn("font-semibold", textScale === "lg" ? "text-3xl" : "text-2xl")}>{displaySunsetTime}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              {resp?.sunsetJst && (
                <div className="text-sm text-gray-300 mt-1">日の入り（JST）: {resp.sunsetJst}</div>
              )}

              <div className="grid gap-4 rounded-3xl border border-white/5 bg-white/5 p-4 text-white/90 md:grid-cols-3">
                {infoRow.map((info) => (
                  <div key={info.label} className="space-y-1">
                    <p className="flex items-center gap-2 text-[11px] uppercase tracking-[0.3em] text-white/50">
                      {info.icon}
                      {info.label}
                    </p>
                    <p className="text-base font-semibold">{info.value}</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-3xl border border-white/5 bg-slate-900/40 p-5 text-white">
                  <p className="text-xs uppercase tracking-[0.4em] text-white/60">夕日指数</p>
                  <div className="mt-3 flex items-end justify-between">
                    <div>
                      <p className="text-5xl font-semibold">{displayScore}</p>
                      <p className="text-xs text-white/60">0 = 厳しい / 100 = ベスト</p>
                    </div>
                    <div className="text-right text-sm text-white/70">
                      {loadingMetrics ? (
                        <span className="inline-flex items-center gap-2">
                          <Spinner /> 更新中
                        </span>
                      ) : (
                        <span>API: {isForecastScore ? "forecast/sunset" : "sunset-index"}</span>
                      )}
                    </div>
                  </div>
                  <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-amber-300 via-orange-400 to-pink-400"
                      style={{ width: `${displayScore}%` }}
                    />
                  </div>
                </div>

                <div className="rounded-3xl border border-white/5 bg-slate-900/40 p-5 text-white">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs uppercase tracking-[0.4em] text-white/60">詳細メトリクス</p>
                    <div className="inline-flex items-center rounded-full border border-white/15 bg-white/5 p-1 text-xs font-medium text-white/70">
                      {["current", "forecast"].map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setMetricsTab(tab as "current" | "forecast")}
                          className={cn(
                            "rounded-full px-3 py-1 transition",
                            metricsTab === tab ? "bg-white text-slate-900" : "text-white/70"
                          )}
                        >
                          {tab === "current" ? "現在" : "日の入り予測"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {metricsTab === "forecast" && (
                    <div className="mt-2 text-[11px] text-white/70">{forecastStatusText}</div>
                  )}
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    {displayMetricCards.map((metric) => (
                      <div key={metric.label} className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <p className="flex items-center gap-2 text-[11px] uppercase tracking-[0.3em] text-white/50">
                          {metric.icon}
                          {metric.label}
                        </p>
                        <p className="mt-1 text-lg font-semibold text-white">{metric.value}</p>
                      </div>
                    ))}
                  </div>
                  {metricsTab === "forecast" && (
                    <p className="mt-3 text-[11px] text-white/60">予報は時間分解能1時間。日の入り±30分の誤差あり</p>
                  )}
                </div>
              </div>
            </div>
          </article>

          <aside className="space-y-6 rounded-[32px] border border-white/5 bg-white/5 p-5 text-white">
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-[0.4em] text-white/60">カードデザイン</p>
              <div className="grid grid-cols-2 gap-3">
                {(["simple", "gradient"] as DesignVariant[]).map((variant) => (
                  <button
                    key={variant}
                    type="button"
                    onClick={() => setDesign(variant)}
                    className={cn(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2",
                      design === variant ? "border-amber-300 bg-amber-300/10 text-white" : "border-white/10 bg-transparent text-white/70"
                    )}
                  >
                    {variant === "simple" ? "シンプル" : "グラデ"}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-xs uppercase tracking-[0.4em] text-white/60">テキストサイズ</p>
              <div className="grid grid-cols-2 gap-3">
                {(["md", "lg"] as TextScale[]).map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setTextScale(size)}
                    className={cn(
                      "rounded-2xl border px-4 py-3 text-sm font-semibold transition",
                      textScale === size ? "border-amber-200 bg-amber-200/10 text-white" : "border-white/10 text-white/70"
                    )}
                  >
                    {size === "md" ? "通常" : "大きめ"}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-[0.4em] text-white/60">撮影地点</Label>
              <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm font-semibold text-white">
                嫁ヶ島ビュー（35.4690, 133.0505）
              </div>
            </div>

            <div className="space-y-3">
              <Button
                type="button"
                onClick={handleSaveImage}
                disabled={!previewUrl}
                className="w-full bg-white/90 font-semibold text-slate-900 hover:bg-white"
              >
                <Download className="mr-2 h-4 w-4" />
                画像を保存
              </Button>
              <Button
                type="button"
                onClick={handleShareX}
                disabled={!previewUrl}
                className="w-full border border-white/30 bg-transparent text-white hover:bg-white/10"
              >
                <Share2 className="mr-2 h-4 w-4" />
                Xにシェア
              </Button>
              <Button
                type="button"
                onClick={handleGenerate}
                disabled={loadingImage}
                className="w-full bg-gradient-to-r from-amber-300 via-orange-400 to-pink-500 text-slate-900 hover:opacity-90"
              >
                {loadingImage ? (
                  <span className="flex items-center gap-2">
                    <Spinner /> 画像を生成中...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    画像を生成する
                  </span>
                )}
              </Button>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function formatSunset(value?: string) {
  if (!value) return "--:--";
  if (/^\d{1,2}:\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatPercentOrPlaceholder(value?: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${Math.round(value)}%`;
  }
  return "--";
}

function formatPmValue(value?: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${value.toFixed(1)} µg/m³`;
  }
  return "データ取得中";
}

function formatForecastTimestamp(value?: string) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function calculateSunsetScore(predicted?: SunsetForecastResponse["predicted"]): number | null {
  if (!predicted) return null;
  const clouds = toFiniteNumber(predicted.cloudCover_pct, 60);
  const humidity = toFiniteNumber(predicted.humidity_pct, 65);
  const pm = toFiniteNumber(predicted.pm25_ugm3, 12);

  const cloudTerm = Math.max(0, 35 - Math.abs(45 - clouds) * 0.7);
  const humidityTerm = Math.max(0, 20 - Math.max(0, humidity - 55) * 0.5);
  const pmTerm = Math.max(0, 30 - Math.max(0, pm - 12) * 2);
  const baseline = 15; // wind・視程など取得できない項目の仮加点

  return clampScore(cloudTerm + humidityTerm + pmTerm + baseline);
}

function toFiniteNumber(value: number | undefined | null, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function deriveObjectKeyFromUrl(candidate?: string) {
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.pathname.replace(/^\/+/, "");
  } catch {
    return candidate.replace(/^\/+/, "");
  }
}

function buildPublicImageUrl(objectKey?: string) {
  const normalized = objectKey?.replace(/^\/+/, "");
  if (!normalized) {
    return undefined;
  }
  return `${CDN_BASE_URL}/${normalized}`;
}

async function downloadCardImage(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`画像の取得に失敗しました (${response.status})`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = buildDownloadFileName();
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function buildDownloadFileName() {
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").split(".")[0];
  return `sunset-card-${timestamp}.jpg`;
}

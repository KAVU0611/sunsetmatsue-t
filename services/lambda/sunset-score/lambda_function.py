import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Tuple

import requests

LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)

API_KEY = os.getenv("OPENWEATHER_API")
LAT = os.getenv("LAT", "35.468")
LON = os.getenv("LON", "133.048")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "https://matsuesunsetai.com",
    "Access-Control-Allow-Credentials": "false",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
}


def lambda_handler(event: Dict[str, Any], _context: Any) -> Dict[str, Any]:
    method = (event or {}).get("httpMethod", "GET")
    if method == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": "",
        }

    if not API_KEY:
        LOGGER.error("OPENWEATHER_API is not configured")
        return _response(500, {"message": "Weather integration not configured"})

    lat, lon = _extract_coords(event)

    try:
        weather = _fetch_weather(lat, lon)
        air_quality = _fetch_air_quality(lat, lon)
        pm25 = air_quality.get("list", [{}])[0].get("components", {}).get("pm2_5")
        score, breakdown = _compute_score(weather, pm25)
        sunset_time, sunset_iso = _extract_sunset(weather)
        weather_desc = (weather.get("weather") or [{}])[0].get("description", "weather data").title()
    except Exception as exc:  # pylint: disable=broad-except
        LOGGER.exception("Failed to compute sunset index")
        return _response(500, {"message": f"Score computation failed: {exc}"})

    return _response(
        200,
        {
            "score": round(score, 1),
            "sunsetTime": sunset_time,
            "sunsetTimeIso": sunset_iso,
            "metrics": {
                "weather": weather_desc,
                "clouds": weather.get("clouds", {}).get("all"),
                "humidity": weather.get("main", {}).get("humidity"),
                "pm25": pm25,
            },
            "breakdown": breakdown,
            "source": "openweather",
            "coords": {"lat": lat, "lon": lon},
        },
    )


def _extract_coords(event: Dict[str, Any]) -> Tuple[float, float]:
    query = (event or {}).get("queryStringParameters") or {}
    lat = query.get("lat") or LAT
    lon = query.get("lon") or LON
    return _coerce_float(lat, LAT), _coerce_float(lon, LON)


def _coerce_float(value: Any, fallback: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(fallback)


def _fetch_weather(lat: float, lon: float) -> Dict[str, Any]:
    url = "https://api.openweathermap.org/data/2.5/weather"
    params = {
        "lat": lat,
        "lon": lon,
        "appid": API_KEY,
        "units": "metric",
        "lang": "ja",
    }
    response = requests.get(url, params=params, timeout=8)
    response.raise_for_status()
    return response.json()


def _fetch_air_quality(lat: float, lon: float) -> Dict[str, Any]:
    url = "https://api.openweathermap.org/data/2.5/air_pollution"
    params = {"lat": lat, "lon": lon, "appid": API_KEY}
    response = requests.get(url, params=params, timeout=8)
    response.raise_for_status()
    return response.json()


def _extract_sunset(weather: Dict[str, Any]) -> Tuple[str, str]:
    sunset_ts = weather.get("sys", {}).get("sunset")
    offset = int(weather.get("timezone", 0))
    if not sunset_ts:
        now = datetime.now(timezone.utc) + timedelta(seconds=offset)
        formatted = now.strftime("%H:%M")
        return formatted, now.isoformat()

    sunset_utc = datetime.fromtimestamp(int(sunset_ts), tz=timezone.utc)
    sunset_local = sunset_utc + timedelta(seconds=offset)
    return sunset_local.strftime("%H:%M"), sunset_local.isoformat()


def _compute_score(weather: Dict[str, Any], pm25: Any) -> Tuple[float, Dict[str, Any]]:
    clouds = weather.get("clouds", {}).get("all", 50)
    humidity = weather.get("main", {}).get("humidity", 60)
    wind = weather.get("wind", {}).get("speed", 3.5)
    visibility = weather.get("visibility", 10000) or 10000
    pm_value = float(pm25) if isinstance(pm25, (int, float)) else 12.0

    cloud_term, clear_sky_boost = _cloud_score(clouds)
    humidity_term = max(0, 20 - max(0, humidity - 55) * 0.5)
    wind_term = max(0, 20 - max(0, wind - 3) * 6)
    visibility_term = max(0, 15 - max(0, (7000 - visibility) / 400))
    pm_term = max(0, 30 - max(0, pm_value - 12) * 2)

    score = min(100, cloud_term + humidity_term + wind_term + visibility_term + pm_term)

    breakdown = {
        "clouds": {
            "value": clouds,
            "weight": round(cloud_term, 1),
            "clearSkyBoost": round(clear_sky_boost, 1),
        },
        "humidity": {"value": humidity, "weight": round(humidity_term, 1)},
        "wind": {"value": wind, "weight": round(wind_term, 1)},
        "visibility": {"value": visibility, "weight": round(visibility_term, 1)},
        "pm25": {"value": pm_value, "weight": round(pm_term, 1)},
    }

    return score, breakdown


def _cloud_score(clouds: Any) -> Tuple[float, float]:
    """Return total cloud term plus the portion gained from the clear-sky boost."""
    try:
        cloud_cover = float(clouds)
    except (TypeError, ValueError):
        cloud_cover = 50.0

    base = max(0.0, 35.0 - abs(45.0 - cloud_cover) * 0.7)
    clear_sky_boost = 0.0
    if cloud_cover <= 25.0:
        clear_sky_boost = max(0.0, (25.0 - cloud_cover) * 1.0)

    total = min(45.0, base + clear_sky_boost)
    return total, clear_sky_boost


def _response(status_code: int, body: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }

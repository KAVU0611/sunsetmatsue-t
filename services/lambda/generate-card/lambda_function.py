import base64
import datetime as dt
import json
import logging
import math
import os
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from io import BytesIO
from typing import Any, Dict, Optional, Tuple

import boto3
import pytz
import requests
from astral import LocationInfo
from astral.sun import sun
from botocore.exceptions import BotoCoreError, ClientError
from PIL import Image, ImageDraw, ImageFont
from zoneinfo import ZoneInfo

from providers import stability as stability_provider

LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)

MODEL_ID = os.getenv("MODEL_ID", "amazon.titan-image-generator-v1")
BEDROCK_REGION = os.getenv("BEDROCK_REGION", "us-east-1")
OUTPUT_BUCKET = os.getenv("OUTPUT_BUCKET")
CLOUDFRONT_DOMAIN = (os.getenv("CLOUDFRONT_DOMAIN") or "").strip()
CDN_HOST = (os.getenv("CDN_HOST") or "").strip()
CODE_VERSION = os.getenv("CODE_VERSION", "2025-11-07-02")
IMG_PROVIDER = (os.getenv("IMG_PROVIDER") or "titan").strip().lower()
JST = ZoneInfo("Asia/Tokyo")
FIXED_LAT = 35.4690
FIXED_LON = 133.0505
LAT = 35.4727
LON = 133.0505
TZ = pytz.timezone("Asia/Tokyo")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "https://matsuesunsetai.com",
    "Access-Control-Allow-Credentials": "false",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
}


def _sunset_jst(target_date: dt.date) -> dt.datetime:
    loc = LocationInfo(latitude=LAT, longitude=LON)
    s = sun(loc.observer, date=target_date, tzinfo=TZ)
    return s["sunset"]


def _open_meteo_hourly(date_str: str) -> Dict[str, Any]:
    common = (
        f"latitude={LAT}&longitude={LON}"
        f"&timezone=Asia%2FTokyo"
        f"&start_date={date_str}&end_date={date_str}"
    )

    forecast_url = f"https://api.open-meteo.com/v1/forecast?hourly=cloudcover,relativehumidity_2m&{common}"
    air_quality_url = f"https://air-quality-api.open-meteo.com/v1/air-quality?hourly=pm2_5&{common}"

    forecast_resp = requests.get(forecast_url, timeout=10)
    forecast_resp.raise_for_status()
    forecast_hourly = forecast_resp.json().get("hourly", {})

    air_resp = requests.get(air_quality_url, timeout=10)
    air_resp.raise_for_status()
    air_hourly = air_resp.json().get("hourly", {})

    times = forecast_hourly.get("time", [])
    pm_map = {ts: val for ts, val in zip(air_hourly.get("time", []), air_hourly.get("pm2_5", []))}
    pm_list = [pm_map.get(ts) for ts in times]

    return {
        "time": times,
        "cloudcover": forecast_hourly.get("cloudcover", []),
        "relative_humidity_2m": forecast_hourly.get("relativehumidity_2m", []),
        "pm2_5": pm_list,
    }


def _nearest_index(times: list[dt.datetime], target: dt.datetime) -> int:
    if not times:
        raise ValueError("No hourly forecast points in response")
    return min(range(len(times)), key=lambda i: math.fabs((times[i] - target).total_seconds()))


def _response(body: Dict[str, Any], status: int = 200) -> Dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
    }
    headers.update(CORS_HEADERS)
    return {
        "statusCode": status,
        "headers": headers,
        "body": json.dumps(body, ensure_ascii=False),
    }

if not OUTPUT_BUCKET:
    LOGGER.error(json.dumps({"message": "Missing OUTPUT_BUCKET env", "codeVersion": CODE_VERSION}))

bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
s3 = boto3.client("s3")


def compute_sunset_jst(target_date: date) -> datetime:
    loc = LocationInfo(latitude=FIXED_LAT, longitude=FIXED_LON)
    timings = sun(loc.observer, date=target_date, tzinfo=JST)
    return timings["sunset"]


class ValidationError(Exception):
    """Raised when the incoming payload is invalid."""


@dataclass
class CardRequest:
    location: str
    date: str
    style: str
    text_size: str
    score: str
    sunset_time: str
    conditions: str
    prompt: Optional[str]

    def summary(self) -> Dict[str, str]:
        return {
            "location": self.location,
            "date": self.date,
            "style": self.style,
            "textSize": self.text_size,
            "score": self.score,
        }


def _style_prompt(style: str) -> str:
    mapping = {
        "simple": "clean documentary photography, minimal color grading, editorial feel",
        "gradient": "dreamy gradient sky, cinematic glow, award-winning travel campaign poster",
    }
    return mapping.get(style, "cinematic sunset postcard with warm tones")


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    request_id = getattr(context, "aws_request_id", str(uuid.uuid4()))

    path = (
        (event.get("rawPath"))
        or (event.get("path"))
        or (event.get("requestContext", {}).get("http", {}).get("path"))
        or ""
    )
    method = (
        (event.get("requestContext", {}).get("http", {}).get("method"))
        or event.get("httpMethod")
        or "GET"
    )

    if method == "OPTIONS":
        return _options_response()

    if method == "GET" and path.endswith("/forecast/sunset"):
        qs = event.get("queryStringParameters") or {}
        date_str = qs.get("date")
        target_date = dt.date.fromisoformat(date_str) if date_str else dt.datetime.now(TZ).date()

        try:
            sunset = _sunset_jst(target_date)
            hourly = _open_meteo_hourly(target_date.isoformat())
            times: list[dt.datetime] = []
            for raw in hourly.get("time", []):
                parsed = dt.datetime.fromisoformat(raw)
                if parsed.tzinfo is None:
                    parsed = TZ.localize(parsed)
                else:
                    parsed = parsed.astimezone(TZ)
                times.append(parsed)
            idx = _nearest_index(times, sunset)
            payload = {
                "location": {"lat": LAT, "lon": LON},
                "sunset_jst": sunset.isoformat(),
                "source": "open-meteo",
                "predicted": {
                    "cloudCover_pct": hourly["cloudcover"][idx],
                    "humidity_pct": hourly["relative_humidity_2m"][idx],
                    "pm25_ugm3": hourly["pm2_5"][idx],
                },
                "hourly_timestamp": times[idx].isoformat(),
                "cache_ttl_sec": 3600,
            }
            return _response(payload, 200)
        except Exception as exc:  # pylint: disable=broad-except
            return _response({"error": "forecast_failed", "detail": str(exc)}, 502)

    try:
        card_request = _parse_payload(event)
        target_date = datetime.now(JST).date()
        sunset = compute_sunset_jst(target_date)
        sunset_str = sunset.strftime("%H:%M")
        card_request.sunset_time = sunset_str
        _log_info("request.received", request_id, payload=card_request.summary())

        raw_image = _generate_image(card_request)
        card_image = _overlay_text(raw_image, card_request)
        object_key = _put_image_to_s3(card_image, card_request)

        s3_url = f"https://{OUTPUT_BUCKET}.s3.amazonaws.com/{object_key}"
        image_url = _image_url(object_key, s3_url)
        response_payload = {
            "imageUrl": image_url,
            "requestId": request_id,
            "s3Url": s3_url,
            "objectKey": object_key,
            "codeVersion": CODE_VERSION,
            "sunsetJst": sunset.strftime("%Y-%m-%d %H:%M %Z"),
        }
        if CLOUDFRONT_DOMAIN:
            response_payload["cloudFrontUrl"] = f"https://{CLOUDFRONT_DOMAIN.rstrip('/')}/{object_key}"

        _log_info(
            "request.completed",
            request_id,
            bucket=OUTPUT_BUCKET,
            objectKey=object_key,
        )
        return _cors_response(200, request_id, response_payload)
    except ValidationError as exc:
        _log_warning("request.validation_failed", request_id, error=str(exc))
        return _error_response(400, "ValidationError", str(exc), request_id)
    except Exception as exc:  # pylint: disable=broad-except
        _log_exception("request.failed", request_id, exc)
        return _error_response(500, "InternalError", "Image generation failed", request_id)


def _parse_payload(event: Dict[str, Any]) -> CardRequest:
    body = event.get("body")
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body or "").decode("utf-8")

    if isinstance(body, str):
        body = body.strip() or "{}"
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ValidationError(f"Invalid JSON payload: {exc}") from exc
    elif isinstance(body, dict):
        payload = body
    else:
        payload = {}

    location = str(payload.get("location", "")).strip()
    date = str(payload.get("date") or datetime.utcnow().strftime("%Y-%m-%d")).strip()
    style = str(payload.get("style") or "gradient").strip().lower() or "gradient"
    text_size = str(payload.get("textSize") or payload.get("text_size") or "md").strip().lower()
    conditions = str(payload.get("conditions") or payload.get("weather") or "").strip() or "clear sky"
    score = str(payload.get("score") or "80").strip()
    sunset_time = str(payload.get("sunsetTime") or payload.get("time") or "18:45").strip()
    prompt = payload.get("prompt")

    if not location:
        raise ValidationError("location is required")

    return CardRequest(
        location=location,
        date=date,
        style=style,
        text_size=text_size if text_size in {"md", "lg"} else "md",
        conditions=conditions,
        score=score,
        sunset_time=sunset_time,
        prompt=prompt,
    )


def _generate_image(card: CardRequest) -> bytes:
    prompt, negative = _compose_prompts(card)
    if IMG_PROVIDER == "stability":
        try:
            result = stability_provider.generate(prompt, negative, 1024, 1024)
            return base64.b64decode(result["image_base64"])
        except Exception as exc:  # pylint: disable=broad-except
            _log_warning("stability.failed", str(uuid.uuid4()), error=str(exc))
            # フォールバックで Titan を利用
            return _generate_image_with_bedrock(prompt)
    return _generate_image_with_bedrock(prompt)


def _compose_prompts(card: CardRequest) -> Tuple[str, str]:
    base_prompt = (
        "award-winning sunset photo of Lake Shinji at Matsue, showcasing the tiny Yomegashima sandbar island with low stone shoreline, "
        "windswept pines, and a pale gray weathered torii gate standing firmly on the island ground above the waterline. "
        "Calm reflective water, cinematic warm gradients. "
        f"Atmosphere: {card.conditions}. Location: {card.location}. Date: {card.date}. "
        f"Visual treatment: {_style_prompt(card.style)}."
    )
    if card.prompt:
        base_prompt = f"{base_prompt} {card.prompt}".strip()
    negative_prompt = "people, tourists, cars, buildings, text, watermark, floating torii, floating island, distortion"
    return base_prompt, negative_prompt


def _generate_image_with_bedrock(prompt: str) -> bytes:
    titan_payload = {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {"text": prompt},
        "imageGenerationConfig": {
            "numberOfImages": 1,
            "height": 1024,
            "width": 1024,
            "cfgScale": 8,
            "quality": "standard",
        },
    }
    _log_info("bedrock.invoke", str(uuid.uuid4()), modelId=MODEL_ID)

    try:
        response = bedrock.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(titan_payload).encode("utf-8"),
        )
        payload = response["body"].read()
    except (BotoCoreError, ClientError) as exc:
        raise RuntimeError(f"Bedrock invoke failed: {exc}") from exc

    try:
        parsed = json.loads(payload.decode("utf-8"))
    except Exception:
        try:
            return base64.b64decode(payload)
        except Exception as decode_error:  # pylint: disable=broad-except
            raise RuntimeError(f"Bedrock response decode failed: {decode_error}") from decode_error

    image_b64 = _extract_image_base64(parsed)
    if not image_b64:
        raise RuntimeError("No image data returned from Bedrock")

    if isinstance(image_b64, str) and image_b64.startswith("data:image"):
        image_b64 = image_b64.split(",", 1)[-1]

    try:
        return base64.b64decode(image_b64)
    except Exception as exc:  # pylint: disable=broad-except
        raise RuntimeError(f"Unable to decode image: {exc}") from exc


def _extract_image_base64(payload: Dict[str, Any]) -> Optional[str]:
    images = payload.get("images")
    if isinstance(images, list) and images:
        first = images[0]
        if isinstance(first, str):
            return first
        if isinstance(first, dict):
            return first.get("b64") or first.get("image")
    output = payload.get("output")
    if isinstance(output, dict):
        nested = output.get("images")
        if isinstance(nested, list) and nested:
            return nested[0]
    return payload.get("image")


def _overlay_text(image_bytes: bytes, card: CardRequest) -> bytes:
    with Image.open(BytesIO(image_bytes)).convert("RGBA") as base:
        width, height = base.size
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        gradient_height = int(height * 0.4)
        for y in range(gradient_height):
            alpha = int(220 * (y / gradient_height))
            draw.line([(0, height - y), (width, height - y)], fill=(13, 16, 35, alpha))

        size_multiplier = 1.2 if card.text_size == "lg" else 1.0
        font_large = _load_font(int(width * 0.08 * size_multiplier))
        font_medium = _load_font(int(width * 0.045 * size_multiplier))
        font_small = _load_font(int(width * 0.035 * size_multiplier))

        padding = int(width * 0.06)
        draw.text(
            (padding, height - gradient_height + padding),
            f"Sunset Score {card.score}",
            font=font_large,
            fill=(255, 255, 255, 240),
        )
        draw.text(
            (padding, height - gradient_height + padding + font_large.size + 12),
            f"{card.date} | 日の入り {card.sunset_time}",
            font=font_medium,
            fill=(255, 223, 186, 235),
        )
        draw.text(
            (padding, height - padding * 0.4),
            f"{card.location} — {card.conditions}",
            font=font_small,
            fill=(255, 200, 137, 235),
        )
        draw.text(
            (width - 40, height - 40),
            f"Sunset {card.sunset_time} JST",
            font=font_small,
            anchor="rd",
            fill=(255, 255, 255, 230),
        )

        composed = Image.alpha_composite(base, overlay)
        buffer = BytesIO()
        composed.convert("RGB").save(buffer, format="JPEG", quality=92, optimize=True)
        buffer.seek(0)
        return buffer.read()


def _put_image_to_s3(image_bytes: bytes, card: CardRequest) -> str:
    timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    location_slug = re.sub(r"[^a-z0-9]+", "-", card.location.lower()).strip("-") or "location"
    object_key = f"generated/{card.date}/{location_slug}-{timestamp}.jpg"

    s3.put_object(
        Bucket=OUTPUT_BUCKET,
        Key=object_key,
        Body=image_bytes,
        ContentType="image/jpeg",
        CacheControl="public, max-age=31536000",
    )
    return object_key


def _image_url(object_key: str, fallback: str) -> str:
    if CDN_HOST:
        return f"{CDN_HOST.rstrip('/')}/{object_key.lstrip('/')}"
    if CLOUDFRONT_DOMAIN:
        return f"https://{CLOUDFRONT_DOMAIN.rstrip('/')}/{object_key.lstrip('/')}"
    return fallback


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    font_candidates = [
        "/opt/fonts/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for font_path in font_candidates:
        if os.path.exists(font_path):
            try:
                return ImageFont.truetype(font_path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _options_response() -> Dict[str, Any]:
    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": "",
    }


def _error_response(
    status_code: int,
    error_type: str,
    message: str,
    request_id: str,
) -> Dict[str, Any]:
    payload = {
        "errorType": error_type,
        "message": message,
        "requestId": request_id,
    }
    return _cors_response(status_code, request_id, payload)


def _cors_response(
    status_code: int,
    request_id: str,
    body: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    response_body = body or {}
    if status_code < 400:
        response_body.setdefault("requestId", request_id)

    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS | {"Content-Type": "application/json"},
        "body": json.dumps(response_body, ensure_ascii=False),
    }


def _log_info(event: str, request_id: str, **kwargs: Any) -> None:
    LOGGER.info(json.dumps({"event": event, "requestId": request_id, **kwargs}, ensure_ascii=False))


def _log_warning(event: str, request_id: str, **kwargs: Any) -> None:
    LOGGER.warning(json.dumps({"event": event, "requestId": request_id, **kwargs}, ensure_ascii=False))


def _log_exception(event: str, request_id: str, exc: Exception) -> None:
    LOGGER.exception(
        json.dumps(
            {
                "event": event,
                "requestId": request_id,
                "errorType": exc.__class__.__name__,
                "message": str(exc),
            },
            ensure_ascii=False,
        )
    )

import os
import base64

import boto3
import requests

_SSM_PARAM = os.environ.get("STABILITY_API_KEY_PARAM", "/sunset/STABILITY_API_KEY")
_REGION = os.environ.get("AWS_REGION", "us-east-1")
_ENDPOINT = os.environ.get(
    "STABILITY_ENDPOINT",
    "https://api.stability.ai/v2beta/stable-image/generate/sd3"
)
_MODEL = os.environ.get("STABILITY_MODEL", "sd3")

_cache = None


def _get_api_key() -> str:
    global _cache
    if _cache:
        return _cache
    ssm = boto3.client("ssm", region_name=_REGION)
    _cache = ssm.get_parameter(Name=_SSM_PARAM, WithDecryption=True)["Parameter"]["Value"]
    return _cache


def generate(prompt: str, negative: str, width: int = 1024, height: int = 1024) -> dict:
    headers = {
        "Authorization": f"Bearer {_get_api_key()}"
    }
    data = {
        "prompt": prompt,
        "negative_prompt": negative,
        "width": width,
        "height": height,
        "output_format": "png",
        "model": _MODEL,
    }
    response = requests.post(
        _ENDPOINT,
        headers=headers,
        data=data,
        files={"none": (None, "")},
        timeout=120,
    )
    response.raise_for_status()

    content_type = response.headers.get("Content-Type", "")
    if content_type.startswith("image/"):
        return {"image_base64": base64.b64encode(response.content).decode("ascii"), "format": "png"}

    payload = response.json()
    if "image" in payload:
        return {"image_base64": payload["image"], "format": payload.get("format", "png")}

    raise RuntimeError(f"Unexpected response from Stability: {payload}")

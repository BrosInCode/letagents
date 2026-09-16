#!/usr/bin/env python3
"""Check persisted messages and live SSE delivery using an isolated invite room."""
import argparse
import json
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class ProbeFailure(Exception):
    pass


def request_json(url, timeout, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = Request(url, data=data, headers={"Content-Type": "application/json", "Cache-Control": "no-cache"})
    with urlopen(request, timeout=timeout) as response:
        if response.status != (200 if payload is None else 201):
            raise ProbeFailure("unexpected HTTP status")
        body = response.read(1048577)
        if len(body) > 1048576:
            raise ProbeFailure("JSON response exceeded probe bounds")
        return json.loads(body)


def events(response, deadline):
    event, data, size = "message", [], 0
    while time.monotonic() < deadline:
        line = response.readline(65537)
        if not line:
            raise ProbeFailure("stream closed before delivery")
        size += len(line)
        if len(line) > 65536 or size > 1048576:
            raise ProbeFailure("stream exceeded probe bounds")
        line = line.decode().rstrip("\r\n")
        if not line:
            if data:
                yield event, json.loads("\n".join(data))
            event, data = "message", []
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].strip())
    raise ProbeFailure("stream deadline exceeded")


def probe(base_url, room_id, timeout=5):
    if not room_id or not 0 < timeout <= 30:
        raise ProbeFailure("invalid probe configuration")
    base = base_url.rstrip("/")
    room = quote(room_id, safe="")
    nonce = "synthetic-monitor:" + uuid.uuid4().hex
    started = time.monotonic()
    stage = "stream_setup"
    try:
        request = Request(base + "/rooms/" + room + "/messages/stream", headers={"Accept": "text/event-stream", "Cache-Control": "no-cache"})
        with urlopen(request, timeout=timeout) as response:
            if response.status != 200 or "text/event-stream" not in response.headers.get("Content-Type", ""):
                raise ProbeFailure("invalid stream response")
            iterator = events(response, time.monotonic() + timeout)
            for event, body in iterator:
                if event == "room_sync":
                    if body.get("room_id") != room_id or body.get("gap"):
                        raise ProbeFailure("stream checkpoint not ready")
                    break
            stage = "message_write"
            sent = request_json(base + "/projects/" + room + "/messages", timeout, {"sender": "Service monitor", "text": nonce})
            if not isinstance(sent.get("id"), str) or sent.get("text") != nonce:
                raise ProbeFailure("write acknowledgement mismatch")
            stage = "live_delivery"
            delivered = False
            for event, body in events(response, time.monotonic() + timeout):
                if event == "message" and body.get("id") == sent["id"] and body.get("text") == nonce:
                    delivered = True
                    break
            if not delivered:
                raise ProbeFailure("message not delivered")
        stage = "persisted_history"
        history = request_json(base + "/rooms/" + room + "/messages/" + quote(sent["id"], safe=""), timeout)
        saved = history.get("message", {})
        if saved.get("id") != sent["id"] or saved.get("text") != nonce:
            raise ProbeFailure("persisted message mismatch")
        return {"status": "ok", "checks": ["message_write", "live_delivery", "persisted_history"], "elapsed_ms": round((time.monotonic() - started) * 1000)}
    except (OSError, ValueError, KeyError, AttributeError, HTTPError, URLError, ProbeFailure) as error:
        # Never log URLs: the invite-room identifier is a credential.
        raise ProbeFailure(stage + ": " + type(error).__name__) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        with open(args.config) as source:
            config = json.load(source)
        result = probe(config["base_url"], config["room_id"], config.get("timeout_seconds", 5))
    except (OSError, ValueError, KeyError, TypeError, ProbeFailure) as error:
        detail = str(error) if isinstance(error, ProbeFailure) else type(error).__name__
        print(json.dumps({"status": "failed", "detail": detail}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

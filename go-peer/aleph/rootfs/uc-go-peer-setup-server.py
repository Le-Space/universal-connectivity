#!/usr/bin/env python3
import ipaddress
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/uc-go-peer")
READY_FILE = os.environ.get("READY_FILE", "/etc/default/uc-go-peer.ready")
CONFIGURE_SCRIPT = "/usr/local/sbin/uc-go-peer-configure.sh"
BOOTSTRAP_SERVICE = os.environ.get("BOOTSTRAP_SERVICE", "uc-go-peer-bootstrap.service")


def _cors_headers(handler: BaseHTTPRequestHandler) -> None:
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "content-type")


def _validate_port(value: object, field_name: str) -> str:
    if not isinstance(value, int) or value < 1 or value > 65535:
        raise ValueError(f"{field_name} must be an integer TCP/UDP port between 1 and 65535")
    return str(value)


def _validate_proxy_hostname(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("proxy_url must be a string when provided")

    candidate = value.strip()
    if not candidate:
        return None

    parsed = urlsplit(candidate if "://" in candidate else f"https://{candidate}")
    if not parsed.hostname:
        raise ValueError("proxy_url must include a valid hostname")
    return parsed.hostname


class Handler(BaseHTTPRequestHandler):
    server_version = "UcGoPeerSetup/1.0"

    def _request_path(self) -> str:
        return urlsplit(self.path).path

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        _cors_headers(self)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        _cors_headers(self)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self._request_path() not in ("/", "/health"):
            self._send_json(404, {"status": "not-found"})
            return

        self._send_json(
            200,
            {
                "status": "waiting-for-port-mapping",
                "ready": os.path.exists(READY_FILE),
                "env_file": ENV_FILE,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self._request_path() != "/configure":
            self._send_json(404, {"status": "not-found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"status": "bad-request", "error": "Invalid Content-Length"})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8") or "{}")
        except json.JSONDecodeError as error:
            self._send_json(400, {"status": "bad-request", "error": f"Invalid JSON body: {error}"})
            return

        try:
            public_ipv4 = str(ipaddress.ip_address(payload.get("public_ipv4")))
            public_ipv6 = payload.get("public_ipv6")
            if public_ipv6 is not None:
                public_ipv6 = str(ipaddress.ip_address(public_ipv6))
            tcp_port = _validate_port(payload.get("tcp_port"), "tcp_port")
            ws_port = _validate_port(payload.get("ws_port"), "ws_port")
            proxy_hostname = _validate_proxy_hostname(payload.get("proxy_url"))
            quic_port = payload.get("quic_port")
            webrtc_port = payload.get("webrtc_port")
            args = [
                CONFIGURE_SCRIPT,
                "--public-ipv4",
                public_ipv4,
                "--tcp-port",
                tcp_port,
                "--ws-port",
                ws_port,
            ]
            if proxy_hostname is not None:
                args.extend(["--proxy-hostname", proxy_hostname])
            if public_ipv6 is not None:
                args.extend(["--public-ipv6", public_ipv6])
            if quic_port is not None:
                validated_quic = _validate_port(quic_port, "quic_port")
                args.extend(["--quic-port", validated_quic, "--webtransport-port", validated_quic])
            if webrtc_port is not None:
                args.extend(["--webrtc-port", _validate_port(webrtc_port, "webrtc_port")])
        except ValueError as error:
            self._send_json(400, {"status": "bad-request", "error": str(error)})
            return

        try:
            result = subprocess.run(args, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as error:
            self._send_json(
                500,
                {
                    "status": "error",
                    "error": error.stderr.strip() or error.stdout.strip() or str(error),
                },
            )
            return

        self._send_json(200, {"status": "configured", "stdout": result.stdout.strip()})
        threading.Thread(target=self.server.shutdown, daemon=True).start()  # type: ignore[arg-type]
        threading.Thread(target=_stop_bootstrap_service, daemon=True).start()


def _stop_bootstrap_service() -> None:
    # Give the HTTP response a brief head start, then stop the temporary setup service.
    time.sleep(1)
    subprocess.run(["systemctl", "stop", BOOTSTRAP_SERVICE], check=False)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", 80), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
import json
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def summarize_rejection(payload: dict) -> str:
    error_code = payload.get("error_code")
    details = payload.get("details")
    first_error = details.get("errors", [None])[0] if isinstance(details, dict) else None

    if error_code == 5 and isinstance(first_error, dict):
        account_balance = first_error.get("account_balance")
        required_balance = first_error.get("required_balance")
        if account_balance is not None and required_balance is not None:
            return (
                "insufficient Aleph balance: "
                f"account has {account_balance}, required is {required_balance}"
            )

    if error_code is None:
        return json.dumps(details or {})
    return f"error {error_code}: {json.dumps(details or {})}"


def fetch_message(api_host: str, item_hash: str) -> dict:
    url = f"{api_host.rstrip('/')}/api/v0/messages/{item_hash}"
    with urlopen(url, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    if len(sys.argv) != 5:
        print(
            "usage: wait-for-aleph-message.py <api_host> <item_hash> <attempts> <delay_seconds>",
            file=sys.stderr,
        )
        return 2

    api_host, item_hash, attempts_text, delay_text = sys.argv[1:5]
    attempts = int(attempts_text)
    delay_seconds = float(delay_text)

    for attempt in range(1, attempts + 1):
        try:
            payload = fetch_message(api_host, item_hash)
        except (HTTPError, URLError, TimeoutError) as exc:
            if attempt >= attempts:
                print(
                    f"Failed to query Aleph message status for {item_hash}: {exc}",
                    file=sys.stderr,
                )
                return 1
            time.sleep(delay_seconds)
            continue

        status = payload.get("status") or ""
        if status == "processed":
            print(json.dumps(payload))
            return 0
        if status == "rejected":
            print(
                f"Aleph STORE message {item_hash} was rejected: {summarize_rejection(payload)}",
                file=sys.stderr,
            )
            return 1

        if attempt < attempts:
            time.sleep(delay_seconds)

    print(
        f"Aleph STORE message {item_hash} did not become processed after {attempts} attempts.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

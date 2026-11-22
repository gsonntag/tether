"""A synchronous, text-only Azure Responses client with one budget per job."""

from collections import Counter
from decimal import Decimal
from email.utils import parsedate_to_datetime
from hashlib import sha256
import json
import random
import re
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class JobStopped(RuntimeError):
    """The harness should stop and surface this error without automatically starting a new job."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def retry_after(headers):
    try:
        if "retry-after-ms" in headers:
            return max(0, float(headers["retry-after-ms"]) / 1000)
        value = headers.get("Retry-After")
        if not value:
            return 0
        try:
            return max(0, float(value))
        except ValueError:
            return max(0, parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return 0


class GuardedJob:
    def __init__(self, endpoint, api_key, deployment, *, max_tokens, max_turns, max_repeats=2,
                 max_usd=None, input_usd_per_million=None, output_usd_per_million=None,
                 max_retries=3, max_retry_delay=60, timeout=120):
        url = urlsplit(endpoint)
        if url.scheme != "https" or not re.fullmatch(
            r"[a-z0-9-]+\.(openai|cognitiveservices)\.azure\.com", url.netloc
        ) or url.path.rstrip("/") not in ("", "/openai/v1") or url.query or url.fragment:
            raise ValueError("Use an Azure OpenAI resource endpoint")
        self.url = f"https://{url.netloc}/openai/v1/responses"
        self.api_key, self.deployment = api_key, deployment
        self.max_tokens, self.max_turns, self.max_repeats = max_tokens, max_turns, max_repeats
        self.max_retries, self.max_retry_delay, self.timeout = max_retries, max_retry_delay, timeout
        if any(type(value) is not int or value < 1 for value in
               (max_tokens, max_turns, max_repeats, max_retry_delay, timeout)):
            raise ValueError("Guard limits must be positive integers")
        if type(max_retries) is not int or max_retries < 0:
            raise ValueError("max_retries must be a nonnegative integer")
        self.max_usd = None if max_usd is None else Decimal(str(max_usd))
        self.rates = (Decimal(0), Decimal(0))
        if self.max_usd is not None:
            if input_usd_per_million is None or output_usd_per_million is None:
                raise ValueError("A dollar limit requires conservative input and output rates")
            self.rates = tuple(Decimal(str(rate)) for rate in (input_usd_per_million, output_usd_per_million))
            if any(not value.is_finite() or value <= 0 for value in (*self.rates, self.max_usd)):
                raise ValueError("The dollar limit and rates must be positive and finite")
        self.turns = self.tokens = 0
        self.usd = Decimal(0)
        self.requests = Counter()
        self.opener = build_opener(NoRedirect())
        self.stopped = None

    def cost(self, input_tokens, output_tokens):
        return (input_tokens * self.rates[0] + output_tokens * self.rates[1]) / 1_000_000

    def stop(self, reason):
        self.stopped = reason
        raise JobStopped(reason)

    def respond(self, text, *, input_token_bound, max_output_tokens):
        """Send a text turn. Supply an upper bound including model framing for this exact request."""
        if self.stopped is not None:
            raise JobStopped(self.stopped)
        if not isinstance(text, str):
            raise TypeError("Only text input is supported")
        if any(type(value) is not int or value < 1 for value in (input_token_bound, max_output_tokens)):
            raise ValueError("Input and output bounds must be positive integers")

        body = json.dumps({"model": self.deployment, "input": text, "max_output_tokens": max_output_tokens,
                           "store": False}, ensure_ascii=True, sort_keys=True).encode()
        fingerprint = sha256(body).digest()
        reserved_tokens = input_token_bound + max_output_tokens
        reserved_usd = self.cost(input_token_bound, max_output_tokens)
        if self.turns >= self.max_turns:
            self.stop("Job turn limit reached")
        if self.requests[fingerprint] >= self.max_repeats:
            self.stop("Job repeated an identical Azure OpenAI request")
        if self.tokens + reserved_tokens > self.max_tokens:
            self.stop("Next request would exceed the job token budget")
        if self.max_usd is not None and self.usd + reserved_usd > self.max_usd:
            self.stop("Next request would exceed the job dollar budget")

        self.turns += 1
        self.requests[fingerprint] += 1
        self.tokens += reserved_tokens
        self.usd += reserved_usd
        request = Request(self.url, body, {"Content-Type": "application/json", "api-key": self.api_key}, method="POST")
        for attempt in range(self.max_retries + 1):
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    result = json.load(response)
                break
            except HTTPError as error:
                code = error.code
                delay = max(retry_after(error.headers), min(2 ** min(attempt, 10), self.max_retry_delay))
                error.close()
                if code != 429:
                    self.stop(f"Azure OpenAI returned HTTP {code}. Reserved usage retained.")
                delay += random.uniform(0, min(1, self.max_retry_delay - delay)) if delay < self.max_retry_delay else 0
                if attempt >= self.max_retries or delay > self.max_retry_delay:
                    self.stop("Azure OpenAI rate limit persisted or requested a longer retry delay")
                time.sleep(delay)
            except (OSError, ValueError):
                self.stop("Azure OpenAI response was unavailable. Reserved usage retained.")

        usage = result.get("usage") if isinstance(result, dict) else None
        if not isinstance(usage, dict):
            self.stop("Azure OpenAI omitted usage. Reserved usage retained.")
        used_in, used_out = usage.get("input_tokens"), usage.get("output_tokens")
        if any(type(value) is not int or value < 0 for value in (used_in, used_out)):
            self.stop("Azure OpenAI reported invalid usage. Reserved usage retained.")
        self.tokens += used_in + used_out - reserved_tokens
        self.usd += self.cost(used_in, used_out) - reserved_usd
        if used_in > input_token_bound or used_out > max_output_tokens:
            self.stop("Azure OpenAI usage exceeded the reservation. Update the harness token bound.")
        return result

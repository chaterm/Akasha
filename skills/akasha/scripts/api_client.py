"""Small, dependency-free HTTP client used by the Akasha Skill."""

from __future__ import annotations

import json
from typing import Any, Callable, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


Transport = Callable[[Request, float], Any]
SKILL_VERSION = "1.0.0"


class ApiError(RuntimeError):
    """Base class for safe, user-facing API errors."""


class ApiConfigurationError(ApiError):
    """Raised for unsafe or invalid local configuration."""


class AuthenticationError(ApiError):
    """Raised when the API key is missing, invalid, or expired."""


class PermissionDeniedError(ApiError):
    """Raised when the API refuses an operation."""


class ApiRequestError(ApiError):
    """Raised for network failures and non-authentication HTTP errors."""


class ApiContractError(ApiError):
    """Raised when the server response does not match the Skill contract."""


class RejectRedirects(HTTPRedirectHandler):
    """Refuse redirects so bearer credentials cannot cross origins."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        original_url = req.full_url if req is not None else newurl
        raise HTTPError(
            original_url,
            code,
            "Redirects are disabled for authenticated requests",
            headers,
            fp,
        )


def _normalize_base_url(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    parsed = urlsplit(value)
    if not parsed.hostname or parsed.username or parsed.password:
        raise ApiConfigurationError("Akasha base URL is invalid.")
    if parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ApiConfigurationError("Akasha base URL must not contain a path or query.")

    local_hosts = {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in local_hosts
    ):
        raise ApiConfigurationError(
            "Akasha base URL must use HTTPS, except for local development."
        )
    return value


class AkashaApiClient:
    """Call the small set of Akasha APIs exposed by this Skill."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout: float = 15.0,
        transport: Transport | None = None,
    ) -> None:
        if not api_key or any(character in api_key for character in ("\n", "\r")):
            raise ApiConfigurationError("Akasha API key is invalid.")
        self.base_url = _normalize_base_url(base_url)
        self._api_key = api_key
        self.timeout = timeout
        if transport is None:
            opener = build_opener(RejectRedirects())
            self._transport: Transport = (
                lambda request, timeout: opener.open(request, timeout=timeout)
            )
        else:
            self._transport = transport
        self._current_user: dict[str, Any] | None = None

    def request_json(self, path: str, body: dict[str, Any]) -> Any:
        """POST JSON and return decoded JSON without exposing secrets in errors."""
        if not path.startswith("/") or path.startswith("//") or "://" in path:
            raise ApiConfigurationError("Akasha API path must be relative.")

        request = Request(
            f"{self.base_url}{path}",
            data=json.dumps(
                body,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-Akasha-Skill-Version": SKILL_VERSION,
            },
            method="POST",
        )

        try:
            with self._transport(request, self.timeout) as response:
                payload = response.read()
        except HTTPError as error:
            status = error.code
            error.close()
            if status == 401:
                raise AuthenticationError(
                    "Akasha API key is invalid or expired."
                ) from None
            if status == 403:
                raise PermissionDeniedError(
                    "Akasha API denied this operation."
                ) from None
            raise ApiRequestError(
                f"Akasha API returned HTTP {status}."
            ) from None
        except (URLError, TimeoutError, OSError):
            raise ApiRequestError("Unable to reach the Akasha API.") from None

        try:
            result = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiContractError("Akasha API returned invalid JSON.") from None

        if (
            isinstance(result, dict)
            and result.get("success") is True
            and "status" in result
            and "data" in result
        ):
            return result["data"]
        return result

    def get_current_user(self) -> dict[str, Any]:
        if self._current_user is not None:
            return self._current_user
        result = self.request_json("/api/users/me", {})
        if not isinstance(result, dict):
            raise ApiContractError("/api/users/me must return an object.")
        self._current_user = result
        return self._current_user

    def get_personal_space_id(self) -> str:
        identity = self.get_current_user()
        access = identity.get("apiAccess")
        personal_space_id = (
            access.get("personalSpaceId") if isinstance(access, dict) else None
        )
        if not isinstance(personal_space_id, str) or not personal_space_id:
            raise ApiContractError(
                "Akasha API did not provide apiAccess.personalSpaceId."
            )
        return personal_space_id

    def list_visible_spaces(self) -> list[dict[str, Any]]:
        spaces: list[dict[str, Any]] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()

        while True:
            body: dict[str, Any] = {"limit": 100}
            if cursor:
                body["cursor"] = cursor
            result = self.request_json("/api/spaces", body)
            if not isinstance(result, dict):
                raise ApiContractError("/api/spaces must return an object.")
            items = result.get("items")
            meta = result.get("meta")
            if not isinstance(items, list) or not isinstance(meta, dict):
                raise ApiContractError("/api/spaces returned invalid pagination.")
            if not all(isinstance(item, dict) for item in items):
                raise ApiContractError("/api/spaces returned an invalid space item.")
            spaces.extend(items)

            if not meta.get("hasNextPage"):
                return spaces
            next_cursor = meta.get("nextCursor")
            if (
                not isinstance(next_cursor, str)
                or not next_cursor
                or next_cursor in seen_cursors
            ):
                raise ApiContractError("/api/spaces returned an invalid next cursor.")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    def query_compiled_wiki(
        self,
        query: str,
        space_ids: Sequence[str],
        *,
        chat_context: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        if not query.strip() or not space_ids:
            raise ApiConfigurationError("Query and at least one space ID are required.")
        body: dict[str, Any] = {
            "query": query,
            "spaceIds": list(space_ids),
        }
        if chat_context is not None:
            body["chatContext"] = list(chat_context)
        result = self.request_json("/api/llm-wiki/query", body)
        if not isinstance(result, dict):
            raise ApiContractError("/api/llm-wiki/query must return an object.")
        return result

    def create_personal_page(
        self,
        *,
        title: str,
        content: str,
        parent_page_id: str | None = None,
        content_format: str = "markdown",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "spaceId": self.get_personal_space_id(),
            "title": title,
            "content": content,
            "format": content_format,
        }
        if parent_page_id:
            body["parentPageId"] = parent_page_id
        result = self.request_json("/api/pages/create", body)
        if not isinstance(result, dict):
            raise ApiContractError("/api/pages/create must return an object.")
        return result

    def search_personal_pages(
        self,
        query: str,
        *,
        limit: int = 10,
    ) -> dict[str, Any]:
        if not query.strip():
            raise ApiConfigurationError("Page search query is required.")
        if limit < 1 or limit > 20:
            raise ApiConfigurationError("Page search limit must be between 1 and 20.")

        self.get_personal_space_id()
        result = self.request_json(
            "/api/pages/search",
            {"query": query, "limit": limit},
        )
        if not isinstance(result, dict) or not isinstance(result.get("items"), list):
            raise ApiContractError("/api/pages/search returned invalid results.")
        if not all(isinstance(item, dict) for item in result["items"]):
            raise ApiContractError("/api/pages/search returned an invalid Page item.")
        return result

    def get_personal_page(self, page_id: str) -> dict[str, Any]:
        if not page_id:
            raise ApiConfigurationError("Page ID is required.")

        personal_space_id = self.get_personal_space_id()
        result = self.request_json(
            "/api/pages/info",
            {"pageId": page_id, "format": "markdown"},
        )
        if not isinstance(result, dict):
            raise ApiContractError("/api/pages/info must return an object.")
        if result.get("spaceId") != personal_space_id:
            raise PermissionDeniedError(
                "Akasha API returned a Page outside the personal space."
            )
        return result

    def update_personal_page(
        self,
        *,
        page_id: str,
        title: str | None = None,
        content: str | None = None,
        operation: str = "replace",
        content_format: str = "markdown",
    ) -> dict[str, Any]:
        if title is None and content is None:
            raise ApiConfigurationError("Page title or content is required.")
        if operation not in {"replace", "append", "prepend"}:
            raise ApiConfigurationError("Unsupported page content operation.")

        self.get_personal_space_id()

        body: dict[str, Any] = {"pageId": page_id}
        if title is not None:
            body["title"] = title
        if content is not None:
            body.update(
                {
                    "content": content,
                    "format": content_format,
                    "operation": operation,
                }
            )
        result = self.request_json("/api/pages/update", body)
        if not isinstance(result, dict):
            raise ApiContractError("/api/pages/update must return an object.")
        return result

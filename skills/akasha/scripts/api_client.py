"""Small, dependency-free HTTP client used by the Akasha Skill."""

from __future__ import annotations

import json
import mimetypes
import re
from pathlib import Path
from typing import Any, Callable, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4


Transport = Callable[[Request, float], Any]
SKILL_VERSION = "1.3.0"
IMAGE_EXTENSIONS = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
}
INTERNAL_CITATION_PAGE_URL = re.compile(r"/p/[A-Za-z0-9_-]+")
# Matches the ".../p/<pageSlug>" segment inside a full browser URL or path.
_CITATION_PAGE_SEGMENT = re.compile(r"/p/([^/?#\s]+)")
# A real slugId is a fixed 10-char [0-9A-Za-z] token (see server generateSlugId);
# it never contains "-", so the title prefix is always separable on "-".
_SLUG_ID = re.compile(r"[0-9A-Za-z]{10}")
_UUID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
    r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def _extract_citation_slug(page_url: str) -> str | None:
    """Extract the canonical /p/<slugId> address from a page URL.

    Accepts the strict internal form (/p/<slugId>) as well as the full
    browser address (http://host/s/<space>/p/<titleSlug>-<slugId>[?...#...]).
    Mirrors the client's extractPageSlugId: take the /p/ segment, and if it
    is not a UUID, keep the last "-"-separated part. Returns None when no
    plausible page slug is present.
    """
    if not isinstance(page_url, str):
        return None
    candidate = page_url.strip()
    if not candidate:
        return None
    match = _CITATION_PAGE_SEGMENT.search(candidate)
    page_slug = match.group(1) if match else candidate
    if _UUID.fullmatch(page_slug):
        return page_slug
    slug_id = page_slug.rsplit("-", 1)[-1]
    if not _SLUG_ID.fullmatch(slug_id):
        return None
    return slug_id


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


def _encode_multipart(
    boundary: str,
    *,
    fields: dict[str, str],
    file_field: str,
    file_name: str,
    file_content: bytes,
    file_type: str,
) -> bytes:
    """Encode the one-file multipart contract used by /api/files/upload."""
    chunks: list[bytes] = []
    boundary_bytes = boundary.encode("ascii")
    for name, value in fields.items():
        chunks.extend(
            [
                b"--" + boundary_bytes + b"\r\n",
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(
                    "utf-8"
                ),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )
    chunks.extend(
        [
            b"--" + boundary_bytes + b"\r\n",
            (
                f'Content-Disposition: form-data; name="{file_field}"; '
                f'filename="{file_name}"\r\n'
            ).encode("utf-8"),
            f"Content-Type: {file_type}\r\n\r\n".encode("ascii"),
            file_content,
            b"\r\n--" + boundary_bytes + b"--\r\n",
        ]
    )
    return b"".join(chunks)


class AkashaApiClient:
    """Call the small set of Akasha APIs exposed by this Skill."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout: float = 60.0,
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

    @staticmethod
    def _validate_api_path(path: str) -> None:
        if not path.startswith("/") or path.startswith("//") or "://" in path:
            raise ApiConfigurationError("Akasha API path must be relative.")

    def _request_bytes(self, request: Request) -> bytes:
        """Send an authenticated request and return its raw response bytes."""
        try:
            with self._transport(request, self.timeout) as response:
                return response.read()
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

    @staticmethod
    def _decode_json(payload: bytes) -> Any:
        if not payload.strip():
            return None
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

    def request_json(self, path: str, body: dict[str, Any]) -> Any:
        """POST JSON and return decoded JSON without exposing secrets in errors."""
        self._validate_api_path(path)

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

        return self._decode_json(self._request_bytes(request))

    def upload_file(
        self,
        *,
        page_id: str,
        file_path: str,
        attachment_id: str | None = None,
    ) -> dict[str, Any]:
        """Upload any local file, optionally overwriting a Page attachment."""
        if not page_id:
            raise ApiConfigurationError("Page ID is required.")
        if attachment_id is not None and not attachment_id:
            raise ApiConfigurationError("Attachment ID is required for replacement.")
        replaced = bool(attachment_id)

        source = Path(file_path)
        if not source.is_file():
            raise ApiConfigurationError("Attachment file does not exist.")
        mime_type = (
            mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        )

        upload_name = (
            source.name.replace("\\", "_")
            .replace('"', "_")
            .replace("\r", "_")
            .replace("\n", "_")
        )
        if attachment_id:
            existing = self.get_attachment_info(attachment_id)
            existing_name = existing["fileName"]
            if Path(existing_name).suffix.lower() != source.suffix.lower():
                raise ApiConfigurationError(
                    "Replacement file must keep the existing file extension."
                )
            # The server keeps the existing attachment file path on update;
            # preserve its filename so the existing Markdown URL remains valid.
            upload_name = existing_name

        boundary = f"----AkashaSkill{uuid4().hex}"
        try:
            file_content = source.read_bytes()
        except OSError:
            raise ApiConfigurationError(
                f"Unable to read attachment file: {source}"
            ) from None

        fields = {"pageId": page_id}
        if attachment_id:
            fields["attachmentId"] = attachment_id
        body = _encode_multipart(
            boundary,
            fields=fields,
            file_field="file",
            file_name=upload_name,
            file_content=file_content,
            file_type=mime_type,
        )
        request = Request(
            f"{self.base_url}/api/files/upload",
            data=body,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Accept": "application/json",
                "X-Akasha-Skill-Version": SKILL_VERSION,
            },
            method="POST",
        )
        result = self._decode_json(self._request_bytes(request))
        if not isinstance(result, dict):
            raise ApiContractError("Akasha attachment upload response is invalid.")

        attachment_id = result.get("id")
        file_name = result.get("fileName")
        if not isinstance(attachment_id, str) or not attachment_id:
            raise ApiContractError("Akasha attachment upload response is missing id.")
        if not isinstance(file_name, str) or not file_name:
            raise ApiContractError(
                "Akasha attachment upload response is missing fileName."
            )

        encoded_name = quote(file_name, safe="")
        url = f"/api/files/{attachment_id}/{encoded_name}"
        actual_mime_type = result.get("mimeType") or mime_type
        markdown = (
            f"![{file_name}]({url})"
            if isinstance(actual_mime_type, str)
            and actual_mime_type.startswith("image/")
            else f"[{file_name}]({url})"
        )
        return {
            "attachmentId": attachment_id,
            "pageId": page_id,
            "fileName": file_name,
            "mimeType": actual_mime_type,
            "fileSize": result.get("fileSize"),
            "url": url,
            "markdown": markdown,
            "replaced": replaced,
        }

    def upload_image(
        self,
        *,
        page_id: str,
        file_path: str,
        attachment_id: str | None = None,
    ) -> dict[str, Any]:
        """Compatibility wrapper for callers that explicitly upload images."""
        if Path(file_path).suffix.lower() not in IMAGE_EXTENSIONS:
            raise ApiConfigurationError(
                "Only .png, .jpg, and .jpeg images are supported."
            )
        return self.upload_file(
            page_id=page_id,
            file_path=file_path,
            attachment_id=attachment_id,
        )

    def replace_file(
        self,
        *,
        page_id: str,
        attachment_id: str,
        file_path: str,
    ) -> dict[str, Any]:
        """Replace any Page attachment while preserving its URL."""
        return self.upload_file(
            page_id=page_id,
            file_path=file_path,
            attachment_id=attachment_id,
        )

    def replace_image(
        self,
        *,
        page_id: str,
        attachment_id: str,
        file_path: str,
    ) -> dict[str, Any]:
        """Replace a Page image while preserving its attachment URL."""
        return self.upload_image(
            page_id=page_id,
            file_path=file_path,
            attachment_id=attachment_id,
        )

    def get_attachment_info(self, attachment_id: str) -> dict[str, Any]:
        if not attachment_id:
            raise ApiConfigurationError("Attachment ID is required.")
        result = self.request_json(
            "/api/files/info",
            {"attachmentId": attachment_id},
        )
        if not isinstance(result, dict):
            raise ApiContractError("Akasha attachment response is invalid.")
        file_name = result.get("fileName")
        if not isinstance(file_name, str) or not file_name:
            raise ApiContractError(
                "Akasha attachment response is missing fileName."
            )
        return result

    def download_attachment(
        self,
        *,
        attachment_id: str,
        output_path: str,
    ) -> dict[str, Any]:
        """Download an ACL-authorized attachment to a local file."""
        info = self.get_attachment_info(attachment_id)
        file_name = info["fileName"]
        url = f"/api/files/{attachment_id}/{quote(file_name, safe='')}"
        request = Request(
            f"{self.base_url}{url}",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Accept": "application/octet-stream",
                "X-Akasha-Skill-Version": SKILL_VERSION,
            },
            method="GET",
        )
        payload = self._request_bytes(request)
        target = Path(output_path)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        except OSError:
            raise ApiConfigurationError(
                "Unable to write the downloaded attachment."
            ) from None
        return {
            "attachmentId": attachment_id,
            "fileName": file_name,
            "mimeType": info.get("mimeType"),
            "fileSize": len(payload),
            "outputPath": str(target),
            "url": url,
        }

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

    def get_personal_space_id_or_none(self) -> str | None:
        identity = self.get_current_user()
        access = identity.get("apiAccess")
        personal_space_id = (
            access.get("personalSpaceId") if isinstance(access, dict) else None
        )
        if isinstance(personal_space_id, str) and personal_space_id:
            return personal_space_id
        return None

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

    def list_space_summaries(self) -> list[dict[str, Any]]:
        """Return readable spaces as {spaceId, name, slug, isPersonal}."""
        personal_space_id = self.get_personal_space_id_or_none()
        summaries: list[dict[str, Any]] = []
        for space in self.list_visible_spaces():
            space_id = space.get("id")
            if not isinstance(space_id, str) or not space_id:
                raise ApiContractError("/api/spaces returned a space without an id.")
            name = space.get("name")
            slug = space.get("slug")
            summaries.append(
                {
                    "spaceId": space_id,
                    "name": name if isinstance(name, str) else None,
                    "slug": slug if isinstance(slug, str) else None,
                    "isPersonal": space_id == personal_space_id,
                }
            )
        return summaries

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

    def get_citation_page(self, page_url: str) -> dict[str, Any]:
        slug_id = _extract_citation_slug(page_url)
        if slug_id is None:
            raise ApiConfigurationError(
                "Shared Page URL must contain an internal /p/<slug> address."
            )
        normalized_url = f"/p/{slug_id}"
        result = self.request_json(
            "/api/llm-wiki/citation-page",
            {"pageUrl": normalized_url},
        )
        if not isinstance(result, dict):
            raise ApiContractError(
                "/api/llm-wiki/citation-page must return an object."
            )
        return result

    def create_page(
        self,
        *,
        title: str,
        content: str,
        space_id: str | None = None,
        parent_page_id: str | None = None,
        content_format: str = "markdown",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "spaceId": space_id or self.get_personal_space_id(),
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

    def create_personal_page(
        self,
        *,
        title: str,
        content: str,
        parent_page_id: str | None = None,
        content_format: str = "markdown",
    ) -> dict[str, Any]:
        return self.create_page(
            title=title,
            content=content,
            parent_page_id=parent_page_id,
            content_format=content_format,
        )

    def search_pages(
        self,
        query: str,
        *,
        limit: int = 10,
        space_id: str | None = None,
    ) -> dict[str, Any]:
        if not query.strip():
            raise ApiConfigurationError("Page search query is required.")
        if limit < 1 or limit > 20:
            raise ApiConfigurationError("Page search limit must be between 1 and 20.")

        body: dict[str, Any] = {"query": query, "limit": limit}
        if space_id:
            body["spaceId"] = space_id
        else:
            self.get_personal_space_id()
        result = self.request_json(
            "/api/pages/search",
            body,
        )
        if not isinstance(result, dict) or not isinstance(result.get("items"), list):
            raise ApiContractError("/api/pages/search returned invalid results.")
        if not all(isinstance(item, dict) for item in result["items"]):
            raise ApiContractError("/api/pages/search returned an invalid Page item.")
        return result

    def search_personal_pages(
        self,
        query: str,
        *,
        limit: int = 10,
    ) -> dict[str, Any]:
        return self.search_pages(query, limit=limit)

    def get_page(self, page_id: str) -> dict[str, Any]:
        if not page_id:
            raise ApiConfigurationError("Page ID is required.")

        result = self.request_json(
            "/api/pages/info",
            {"pageId": page_id, "format": "markdown"},
        )
        if not isinstance(result, dict):
            raise ApiContractError("/api/pages/info must return an object.")
        return result

    def get_personal_page(self, page_id: str) -> dict[str, Any]:
        return self.get_page(page_id)

    def update_page(
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

    def update_personal_page(
        self,
        *,
        page_id: str,
        title: str | None = None,
        content: str | None = None,
        operation: str = "replace",
        content_format: str = "markdown",
    ) -> dict[str, Any]:
        return self.update_page(
            page_id=page_id,
            title=title,
            content=content,
            operation=operation,
            content_format=content_format,
        )

    def _assert_page_in_personal_space(self, page_id: str) -> str:
        """Confirm the page lives in the personal space before mutating it.

        The delete and restore endpoints only enforce space edit permission,
        not personal-space ownership, so the Skill keeps that boundary here by
        reading the page first and refusing anything outside the personal space.
        """
        if not page_id:
            raise ApiConfigurationError("Page ID is required.")
        personal_space_id = self.get_personal_space_id()
        page = self.request_json(
            "/api/pages/info",
            {"pageId": page_id},
        )
        if not isinstance(page, dict) or not page.get("spaceId"):
            raise ApiContractError("/api/pages/info must return an object.")
        if page.get("spaceId") != personal_space_id:
            raise PermissionDeniedError(
                "Akasha Skill only manages Pages in the personal space."
            )
        return personal_space_id

    def delete_personal_page(self, page_id: str) -> dict[str, Any]:
        """Soft-delete (trash) a personal Page. Never permanently deletes."""
        self._assert_page_in_personal_space(page_id)
        # permanentlyDelete is intentionally omitted: it requires space admin
        # rights and is irreversible, which is outside the Skill's scope.
        self.request_json("/api/pages/delete", {"pageId": page_id})
        return {"pageId": page_id, "deleted": True}

    def restore_personal_page(self, page_id: str) -> dict[str, Any]:
        """Restore a soft-deleted personal Page from the trash."""
        personal_space_id = self._assert_page_in_personal_space(page_id)
        result = self.request_json("/api/pages/restore", {"pageId": page_id})
        if not isinstance(result, dict) or result.get("spaceId") != personal_space_id:
            raise PermissionDeniedError(
                "Akasha Skill only manages Pages in the personal space."
            )
        return {"pageId": page_id, "restored": True}

    def list_recent_personal_pages(
        self,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """List recently updated Pages in the personal space."""
        return self._list_personal_pages("/api/pages/recent", limit, cursor)

    def list_deleted_personal_pages(
        self,
        *,
        limit: int = 20,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """List trashed Pages in the personal space, restore candidates."""
        return self._list_personal_pages("/api/pages/trash", limit, cursor)

    def _list_personal_pages(
        self,
        path: str,
        limit: int,
        cursor: str | None,
    ) -> dict[str, Any]:
        if limit < 1 or limit > 100:
            raise ApiConfigurationError("Page list limit must be between 1 and 100.")
        personal_space_id = self.get_personal_space_id()
        body: dict[str, Any] = {"spaceId": personal_space_id, "limit": limit}
        if cursor:
            body["cursor"] = cursor
        result = self.request_json(path, body)
        if result is None:
            return {"items": [], "meta": {"count": 0, "limit": limit}}
        if not isinstance(result, dict) or not isinstance(result.get("items"), list):
            raise ApiContractError(f"{path} returned invalid results.")
        items: list[dict[str, Any]] = []
        for page in result["items"]:
            if not isinstance(page, dict) or not page.get("id"):
                raise ApiContractError(f"{path} returned an invalid Page item.")
            if page.get("spaceId") != personal_space_id:
                raise PermissionDeniedError(
                    "Akasha Skill only manages Pages in the personal space."
                )
            items.append(
                {
                    "pageId": page.get("id"),
                    "title": page.get("title"),
                    "updatedAt": page.get("updatedAt"),
                    "deletedAt": page.get("deletedAt"),
                }
            )
        meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
        return {
            "items": items,
            "meta": {
                "count": len(items),
                "limit": limit,
                "hasNextPage": bool(meta.get("hasNextPage")),
                "nextCursor": meta.get("nextCursor"),
            },
        }

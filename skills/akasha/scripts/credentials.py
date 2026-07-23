"""Cross-platform credential storage used by the Akasha Skill."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import sys
import tempfile
from typing import Mapping


BASE_URL_ENV = "AKASHA_API_BASE_URL"
API_KEY_ENV = "AKASHA_API_KEY"


class CredentialError(ValueError):
    """Raised when Akasha credentials are missing or malformed."""


@dataclass(frozen=True)
class Credentials:
    base_url: str
    api_key: str


def credentials_path(
    *,
    platform: str | None = None,
    home: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> Path:
    """Return the credential file path under the user's home directory."""
    current_platform = platform or sys.platform
    user_home = home or Path.home()
    if current_platform.startswith("linux"):
        return user_home / ".config" / "akasha" / "credentials.env"
    return user_home / ".akasha" / "credentials.env"


def _parse_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}

    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def load_credentials(
    *,
    path: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> Credentials:
    """Load credentials, with environment variables overriding saved values."""
    current_environ = os.environ if environ is None else environ
    target = path or credentials_path(environ=current_environ)
    saved = _parse_file(target)
    base_url = current_environ.get(BASE_URL_ENV) or saved.get(BASE_URL_ENV)
    api_key = current_environ.get(API_KEY_ENV) or saved.get(API_KEY_ENV)

    if not base_url or not api_key:
        raise CredentialError(
            "Akasha credentials are missing. Run 'auth login' first."
        )
    return Credentials(base_url=base_url, api_key=api_key)


def _validate_value(name: str, value: str) -> None:
    if not value or any(character in value for character in ("\n", "\r", "\0")):
        raise CredentialError(f"{name} is empty or contains an invalid character")


def save_credentials(
    value: Credentials,
    *,
    path: Path | None = None,
) -> Path:
    """Atomically save credentials and restrict POSIX permissions."""
    _validate_value(BASE_URL_ENV, value.base_url)
    _validate_value(API_KEY_ENV, value.api_key)

    target = path or credentials_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        target.parent.chmod(0o700)

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".credentials.",
        dir=target.parent,
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        if os.name != "nt":
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(f"{BASE_URL_ENV}={value.base_url}\n")
            handle.write(f"{API_KEY_ENV}={value.api_key}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        if os.name != "nt":
            target.chmod(0o600)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise

    return target


def delete_credentials(*, path: Path | None = None) -> None:
    """Delete only the Akasha credential file."""
    (path or credentials_path()).unlink(missing_ok=True)


def credential_summary(value: Credentials) -> dict[str, str]:
    """Return non-secret information suitable for terminal output."""
    fingerprint = hashlib.sha256(value.api_key.encode("utf-8")).hexdigest()[:12]
    return {
        "baseUrl": value.base_url,
        "keyFingerprint": fingerprint,
    }

#!/usr/bin/env python3
"""Akasha Skill command-line entry point."""

from __future__ import annotations

import argparse
import getpass
import json
from pathlib import Path
import sys
from typing import Callable, Sequence, TextIO

from api_client import (
    ApiConfigurationError,
    ApiContractError,
    ApiRequestError,
    AuthenticationError,
    PermissionDeniedError,
)
from credentials import (
    CredentialError,
    Credentials,
    credential_summary,
    delete_credentials,
    load_credentials,
    save_credentials,
)


ClientFactory = Callable[[str, str], object]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="akasha")
    commands = parser.add_subparsers(dest="command", required=True)

    auth = commands.add_parser("auth", help="Manage Akasha credentials")
    auth_commands = auth.add_subparsers(dest="auth_command", required=True)

    login = auth_commands.add_parser("login", help="Validate and save an API key")
    login.add_argument("--base-url", required=True)
    auth_commands.add_parser("status", help="Show the active credential profile")
    auth_commands.add_parser("logout", help="Delete the saved credential profile")

    query = commands.add_parser("query", help="Query compiled Wiki knowledge")
    query.add_argument("question")
    query.add_argument("--space-id", action="append", dest="space_ids")

    page = commands.add_parser("page", help="Write pages in the personal space")
    page_commands = page.add_subparsers(dest="page_command", required=True)

    create_page = page_commands.add_parser(
        "create",
        help="Create a page in the personal space",
    )
    create_page.add_argument("--title", required=True)
    create_page.add_argument("--content-file", required=True)
    create_page.add_argument("--parent-page-id")

    update_page = page_commands.add_parser(
        "update",
        help="Update a page in the personal space",
    )
    update_page.add_argument("page_id")
    update_page.add_argument("--title")
    update_page.add_argument("--content-file")
    update_page.add_argument(
        "--operation",
        choices=("replace", "append", "prepend"),
        default="replace",
    )

    search_page = page_commands.add_parser(
        "search",
        help="Search page source in the personal space",
    )
    search_page.add_argument("query")
    search_page.add_argument("--limit", type=int, default=10)

    get_page = page_commands.add_parser(
        "get",
        help="Read a page from the personal space",
    )
    get_page.add_argument("page_id")

    return parser


def _write_json(stream: TextIO, value: object) -> None:
    stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    stream.write("\n")


def _default_client_factory(base_url: str, api_key: str) -> object:
    from api_client import AkashaApiClient

    return AkashaApiClient(base_url=base_url, api_key=api_key)


def _create_client(
    factory: ClientFactory,
    *,
    credential_file: Path | None,
) -> tuple[object, dict[str, object]]:
    value = load_credentials(path=credential_file)
    client = factory(value.base_url, value.api_key)
    identity = client.get_current_user()
    if not isinstance(identity, dict):
        raise ApiContractError("/api/users/me must return an object.")
    return client, identity


def _with_skill_update_notice(
    result: dict[str, object],
    identity: dict[str, object],
) -> dict[str, object]:
    notice = identity.get("skillUpdateNotice")
    if not isinstance(notice, dict):
        return result
    return {**result, "skillUpdateNotice": notice}


def _write_error(
    stream: TextIO,
    message: str,
    identity: dict[str, object],
) -> None:
    stream.write(f"{message}\n")
    notice = identity.get("skillUpdateNotice")
    if isinstance(notice, dict):
        _write_json(stream, {"skillUpdateNotice": notice})


def _space_ids(spaces: object) -> list[str]:
    if not isinstance(spaces, list):
        raise ApiContractError("Akasha visible spaces response is invalid.")
    result: list[str] = []
    seen: set[str] = set()
    for space in spaces:
        space_id = space.get("id") if isinstance(space, dict) else None
        if isinstance(space_id, str) and space_id and space_id not in seen:
            result.append(space_id)
            seen.add(space_id)
    if not result:
        raise ApiContractError("No readable Akasha spaces are available.")
    return result


def _compact_query_result(result: object) -> dict[str, object]:
    if not isinstance(result, dict):
        raise ApiContractError("Akasha Wiki query response is invalid.")
    return {
        "answer": result.get("answer", ""),
        "citations": result.get("citations", []),
        "warnings": result.get("warnings", []),
        "completenessNotice": result.get("completenessNotice"),
    }


def _read_utf8_content(path_value: str, input_stream: TextIO) -> str:
    if path_value == "-":
        return input_stream.read()
    try:
        return Path(path_value).read_text(encoding="utf-8")
    except OSError:
        raise ApiConfigurationError("Unable to read the UTF-8 content file.") from None


def _page_write_result(result: object) -> dict[str, object]:
    if not isinstance(result, dict):
        raise ApiContractError("Akasha Page response is invalid.")
    page_id = result.get("id")
    space_id = result.get("spaceId")
    if (
        not isinstance(page_id, str)
        or not page_id
        or not isinstance(space_id, str)
        or not space_id
    ):
        raise ApiContractError("Akasha Page response is missing page identifiers.")
    return {
        "pageId": page_id,
        "spaceId": space_id,
        "knowledgeStatus": "pending_compilation",
        "notice": "Page 写入成功；等待 Wiki 编译后才可查询。",
    }


def _page_read_result(result: object) -> dict[str, object]:
    if not isinstance(result, dict):
        raise ApiContractError("Akasha Page response is invalid.")
    page_id = result.get("id")
    space_id = result.get("spaceId")
    title = result.get("title")
    content = result.get("content")
    if (
        not isinstance(page_id, str)
        or not page_id
        or not isinstance(space_id, str)
        or not space_id
        or not isinstance(title, str)
        or not isinstance(content, (str, type(None)))
    ):
        raise ApiContractError("Akasha Page response is missing readable content.")
    return {
        "pageId": page_id,
        "spaceId": space_id,
        "title": title,
        "content": content or "",
        "updatedAt": result.get("updatedAt"),
    }


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    input_secret: Callable[[str], str] | None = None,
    client_factory: ClientFactory | None = None,
    credential_file: Path | None = None,
) -> int:
    """Run the CLI and return a stable process exit code."""
    input_stream = stdin or sys.stdin
    output = stdout or sys.stdout
    error_output = stderr or sys.stderr
    args = _build_parser().parse_args(argv)
    factory = client_factory or _default_client_factory
    identity: dict[str, object] = {}

    try:
        if args.command == "auth" and args.auth_command == "login":
            reader = input_secret or getpass.getpass
            api_key = reader("Akasha API Key: ")
            client = factory(args.base_url, api_key)
            identity = client.get_current_user()
            save_credentials(
                Credentials(base_url=args.base_url, api_key=api_key),
                path=credential_file,
            )
            _write_json(
                output,
                _with_skill_update_notice(
                    {
                        "authenticated": True,
                        "user": identity.get("user"),
                        "workspace": identity.get("workspace"),
                        "apiAccess": identity.get("apiAccess"),
                    },
                    identity,
                ),
            )
            return 0

        if args.command == "auth" and args.auth_command == "status":
            value = load_credentials(path=credential_file)
            _write_json(output, credential_summary(value))
            return 0

        if args.command == "auth" and args.auth_command == "logout":
            delete_credentials(path=credential_file)
            _write_json(output, {"authenticated": False})
            return 0

        if args.command == "query":
            client, identity = _create_client(
                factory,
                credential_file=credential_file,
            )
            space_ids = args.space_ids or _space_ids(client.list_visible_spaces())
            result = client.query_compiled_wiki(args.question, space_ids)
            _write_json(
                output,
                _with_skill_update_notice(_compact_query_result(result), identity),
            )
            return 0

        if args.command == "page" and args.page_command == "create":
            client, identity = _create_client(
                factory,
                credential_file=credential_file,
            )
            result = client.create_personal_page(
                title=args.title,
                content=_read_utf8_content(args.content_file, input_stream),
                parent_page_id=args.parent_page_id,
            )
            _write_json(
                output,
                _with_skill_update_notice(_page_write_result(result), identity),
            )
            return 0

        if args.command == "page" and args.page_command == "search":
            client, identity = _create_client(
                factory,
                credential_file=credential_file,
            )
            result = client.search_personal_pages(
                query=args.query,
                limit=args.limit,
            )
            _write_json(
                output,
                _with_skill_update_notice(result, identity),
            )
            return 0

        if args.command == "page" and args.page_command == "get":
            client, identity = _create_client(
                factory,
                credential_file=credential_file,
            )
            result = client.get_personal_page(args.page_id)
            _write_json(
                output,
                _with_skill_update_notice(_page_read_result(result), identity),
            )
            return 0

        if args.command == "page" and args.page_command == "update":
            content = (
                _read_utf8_content(args.content_file, input_stream)
                if args.content_file is not None
                else None
            )
            if args.title is None and content is None:
                raise ApiConfigurationError(
                    "Page update requires --title or --content-file."
                )
            client, identity = _create_client(
                factory,
                credential_file=credential_file,
            )
            result = client.update_personal_page(
                page_id=args.page_id,
                title=args.title,
                content=content,
                operation=args.operation,
            )
            _write_json(
                output,
                _with_skill_update_notice(_page_write_result(result), identity),
            )
            return 0
    except (CredentialError, AuthenticationError) as error:
        _write_error(error_output, str(error), identity)
        return 3
    except PermissionDeniedError as error:
        _write_error(error_output, str(error), identity)
        return 4
    except ApiConfigurationError as error:
        _write_error(error_output, str(error), identity)
        return 2
    except ApiContractError as error:
        _write_error(error_output, str(error), identity)
        return 6
    except ApiRequestError as error:
        _write_error(error_output, str(error), identity)
        return 5
    except Exception:
        _write_error(error_output, "Akasha API request failed.", identity)
        return 5

    error_output.write("Unsupported command.\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
